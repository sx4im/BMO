#!/usr/bin/env python3
"""Reproduce security checks in bounded Docker containers without production secrets.

prepare downloads binary dependencies with project hooks disabled. All application
tests run with no network, read-only source/dependencies, and scratch-only writes.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".security-test"
if CACHE.is_symlink():
    raise SystemExit("Refusing a symlinked security-test directory.")
CACHE.mkdir(exist_ok=True)
for directory in ("logs", "python", "redis", "tool-home", "pip-cache"):
    if (CACHE / directory).is_symlink(): raise SystemExit("Refusing a symlinked test cache.")
    (CACHE / directory).mkdir(exist_ok=True)
TOOL_ENV = {"PATH":"/usr/local/bin:/usr/bin:/bin", "HOME":str(CACHE / "tool-home")}
IMAGES = {"python":"python:3.12-slim", "node":"node:24-alpine", "postgres":"postgres:16-alpine", "redis":"redis:7.4-alpine"}
TAG = hashlib.sha256(str(ROOT).encode()).hexdigest()[:10]
FIXTURES = {kind:f"bimo-security-{kind}-{TAG}" for kind in ("postgres","redis")}
PASSWORD = "bimo-fixture-only-password"


def docker(*args, check=True, timeout=30):
    result = subprocess.run(["docker", *args], env=TOOL_ENV, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        print(result.stderr[-4000:], file=sys.stderr)
        raise SystemExit(result.returncode)
    return result


def mount(source, target, writable=False):
    return ["--mount", f"type=bind,src={source},dst={target}" + ("" if writable else ",readonly")]


def run_box(kind, image, command, mounts=(), *, network="none", environment=None, workdir="/scratch", seconds=300):
    name = f"bimo-check-{kind}-{uuid.uuid4().hex[:10]}"
    log = CACHE / "logs" / f"{kind}-{time.time_ns()}.log"
    args = ["docker","run","--rm","--init","--name",name,"--network",network,"--memory","2147483648",
        "--cpus","2","--pids-limit","128","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges",
        "--user",f"{os.getuid()}:{os.getgid()}","--ulimit","nofile=512:512","--ulimit","fsize=134217728:134217728",
        "--log-driver","none","--tmpfs","/scratch:rw,nosuid,mode=1777,size=1073741824",
        "--tmpfs","/tmp:rw,nosuid,mode=1777,size=67108864"]
    for source,target,writable in mounts:
        args += mount(source,target,writable)
    variables = {"HOME":"/scratch","TMPDIR":"/scratch","XDG_CACHE_HOME":"/scratch","PATH":"/usr/local/bin:/usr/bin:/bin",
        "OPENBLAS_NUM_THREADS":"1","OMP_NUM_THREADS":"1", **(environment or {})}
    args += ["--workdir",workdir,"--entrypoint","/usr/bin/env",image,"-i"]
    args += [f"{key}={value}" for key,value in variables.items()] + command
    try:
        with log.open("wb") as output:
            # Bound host-side output too; the container never writes daemon logs.
            result = subprocess.run(["prlimit","--fsize=4194304","--",*args], env=TOOL_ENV,
                stdout=output, stderr=subprocess.STDOUT, timeout=seconds)
        text = log.read_text(errors="replace")
        print("\n".join(text.splitlines()[-45:]),flush=True)
        print(f"Full output: {log}",flush=True)
        if result.returncode: raise SystemExit(result.returncode)
    finally:
        docker("rm","-f",name,check=False)


def inputs():
    return {str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in
        (ROOT/"backend/requirements.txt",ROOT/"frontend/package.json",ROOT/"frontend/package-lock.json")}


def toolchain_images():
    images = {}
    for kind,image in IMAGES.items():
        print(f"Preparing public toolchain image: {image}",flush=True)
        cached=docker("image","inspect",image,check=False)
        if cached.returncode:
            docker("pull",image,timeout=600)
            cached=docker("image","inspect",image)
        images[kind] = json.loads(cached.stdout)[0]["RepoDigests"][0]
    return images


def prepare():
    (CACHE/"prepared.json").unlink(missing_ok=True)
    images = toolchain_images()
    shutil.rmtree(CACHE/"python")
    (CACHE/"python").mkdir()
    run_box("prepare-python",images["python"], ["python","-m","pip","install","--only-binary=:all:","--upgrade",
        "--target","/deps","-r","/input/requirements.txt","pip==26.3","setuptools==84.2.1"],
        [(ROOT/"backend/requirements.txt","/input/requirements.txt",False),(CACHE/"python","/deps",True),
         (CACHE/"pip-cache","/pip-cache",True)],
        network="bridge", environment={"PIP_CONFIG_FILE":"/dev/null","PIP_CACHE_DIR":"/pip-cache"},seconds=1800)
    modules = ROOT/"frontend/node_modules"
    if modules.is_symlink(): raise SystemExit("Refusing symlinked node_modules.")
    modules.mkdir(exist_ok=True)
    run_box("prepare-node",images["node"],["npm","ci","--ignore-scripts","--audit=false","--fund=false","--userconfig=/dev/null"],
        [(ROOT/"frontend/package.json","/input/package.json",False),(ROOT/"frontend/package-lock.json","/input/package-lock.json",False),
         (modules,"/input/node_modules",True)],network="bridge",workdir="/input",seconds=300)
    (CACHE/"prepared.json").write_text(json.dumps({"inputs":inputs(),"images":images},indent=2)+"\n")


def prepared():
    try: state=json.loads((CACHE/"prepared.json").read_text())
    except (FileNotFoundError,ValueError): raise SystemExit("Run scripts/security-checks.py prepare first.")
    if state["inputs"] != inputs(): raise SystemExit("Dependency inputs changed. Run prepare again.")
    return state["images"]


def fixture_exists(kind):
    result = docker("inspect",FIXTURES[kind],check=False)
    if result.returncode: return False
    details=json.loads(result.stdout)[0]
    if details["Config"].get("Labels",{}).get("io.bimo.security-test") != TAG:
        raise SystemExit("Refusing a container without this checkout's test label.")
    return details["State"]["Running"]


def fixtures(images):
    for kind in ("postgres","redis"):
        if fixture_exists(kind): continue
        docker("rm","-f",FIXTURES[kind],check=False)
        args=["run","-d","--name",FIXTURES[kind],"--label",f"io.bimo.security-test={TAG}","--network","none",
            "--memory","536870912" if kind=="postgres" else "100663296","--cpus","1","--pids-limit","128",
            "--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--tmpfs","/tmp:rw,nosuid,mode=1777,size=67108864"]
        if kind=="postgres":
            args += ["--user","postgres","--tmpfs","/data:rw,nosuid,mode=1777,size=536870912",
                "--tmpfs","/var/run/postgresql:rw,nosuid,mode=1777,size=16777216",
                "-e","PGDATA=/data/pgdata","-e","POSTGRES_HOST_AUTH_METHOD=trust","-e","POSTGRES_DB=bimo_security"]
            args += mount(ROOT/"backend/migrations","/migrations") + mount(ROOT/"backend/tests","/tests") + [images[kind]]
        else:
            args += ["--user",f"{os.getuid()}:{os.getgid()}"] + mount(CACHE/"redis","/data",True)
            args += [images[kind],"redis-server","--port","0","--unixsocket","/data/redis.sock","--unixsocketperm","777",
                "--requirepass",PASSWORD,"--save","","--appendonly","no","--maxmemory","32mb","--maxmemory-policy","noeviction"]
        docker(*args)
    for _ in range(40):
        # The entrypoint's temporary Unix server can report ready before the
        # fixture database exists. Only the final server listens on loopback.
        ready=docker("exec",FIXTURES["postgres"],"psql","-h","127.0.0.1","-U","postgres","-d","bimo_security","-XAtqc","select 1",check=False).returncode==0
        if ready and (CACHE/"redis/redis.sock").exists(): break
        time.sleep(0.25)
    else: raise SystemExit("Local database fixtures did not become ready.")
    exists=docker("exec","--user","postgres",FIXTURES["postgres"],"psql","-XAt","-d","bimo_security","-c","select to_regclass('public.bmo_fixture_ready')").stdout.strip()
    if not exists:
        partial=docker("exec","--user","postgres",FIXTURES["postgres"],"psql","-XAt","-d","bimo_security","-c","select to_regclass('auth.users')").stdout.strip()
        if partial: raise SystemExit("Partially initialized disposable fixture. Run cleanup, then retry.")
        sql_file("/tests/security_fixture.sql")
        for path in sorted((ROOT/"backend/migrations").glob("*.sql")):
            if not path.name.endswith("_down.sql"): sql_file("/migrations/"+path.name)
        docker("exec","--user","postgres",FIXTURES["postgres"],"psql","-X","-v","ON_ERROR_STOP=1","-d","bimo_security",
            "-c","create table public.bmo_fixture_ready (ready boolean not null)")


def sql_file(path):
    result=docker("exec","--user","postgres",FIXTURES["postgres"],"psql","-X","-v","ON_ERROR_STOP=1","-d","bimo_security","-f",path,timeout=90)
    print(result.stdout,flush=True)


def verify(kind,targets):
    if kind=="secrets":
        return scan_secrets()
    # SQL and edge checks do not use Python/npm dependencies and can run while
    # dependency preparation is unavailable. Backend/frontend require its hash.
    images=toolchain_images() if kind in ("sql","edge") else prepared()
    if kind in ("backend","sql"): fixtures(images)
    if kind=="sql":
        for name in ("security_rls.sql","security_usage.sql","security_retention.sql"): sql_file("/tests/"+name)
        result=docker("exec","--user","postgres","-e","PGDATABASE=bimo_security","-e","PGUSER=postgres",FIXTURES["postgres"],"sh","/tests/security_concurrency.sh",timeout=90)
        print(result.stdout,flush=True);return
    if kind=="backend":
        mounts=[(ROOT/"backend"/name,"/app/backend/"+name,False) for name in ("app","tests","migrations","pytest.ini")]
        mounts += [(CACHE/"python","/deps",False),(CACHE/"redis","/redis",False)]
        if Path("/usr/share/fonts").exists(): mounts += [(Path("/usr/share/fonts"),"/usr/share/fonts",False)]
        env={"PYTHONPATH":"/deps:/app/backend","PYTHONDONTWRITEBYTECODE":"1","PYTHON_DOTENV_DISABLED":"1",
            "BMO_ENV":"test","RATELIMIT_ENABLED":"0","RATELIMIT_STORAGE_URI":"memory://","NVIDIA_TIMEOUT":"0.1",
            "WHATSAPP_DB_PATH":"/scratch/whatsapp.db","BMO_STATE_DIR":"/scratch/state",
            "BMO_TEST_REDIS_URL":f"redis+unix://:{PASSWORD}@/redis/redis.sock"}
        run_box(kind,images["python"],["sh","-c",'python -S -m pip check && python -S -m pytest -q -p no:cacheprovider "$@"',"tests",*(targets or ["tests"])],mounts,environment=env,workdir="/app/backend")
    else:
        source=ROOT/("frontend" if kind=="frontend" else "edge")
        mounts=[(source,"/app/"+source.name,False)]
        if kind=="frontend": mounts += [(ROOT/"vercel.json","/app/vercel.json",False)]
        files=targets or ["tests/"+path.name for path in sorted((source/"tests").glob("*.test.mjs"))]
        command=["node","--max-old-space-size=256"]
        if kind=="frontend":command += ["--experimental-vm-modules"]
        run_box(kind,images["node"],command+["--test","--test-concurrency=2",*files],mounts,workdir="/app/"+source.name)


def scan_secrets():
    image="ghcr.io/gitleaks/gitleaks:v8.30.1"
    if docker("image","inspect",image,check=False).returncode:
        docker("pull",image,timeout=600)
    image=json.loads(docker("image","inspect",image).stdout)[0]["RepoDigests"][0]
    snapshot=CACHE/("secret-source-"+uuid.uuid4().hex)
    snapshot.mkdir(mode=0o700)
    try:
        result=subprocess.run(["git","-C",str(ROOT),"ls-files","--cached","--others","--exclude-standard","-z"],
            env=TOOL_ENV,capture_output=True,check=True)
        for raw in result.stdout.split(b"\0"):
            if not raw:continue
            relative=Path(os.fsdecode(raw))
            source=ROOT/relative
            if relative.is_absolute() or ".." in relative.parts or not source.resolve().is_relative_to(ROOT):
                continue
            if source.is_symlink() or not source.is_file():continue
            destination=snapshot/relative
            destination.parent.mkdir(parents=True,exist_ok=True)
            shutil.copyfile(source,destination)
        run_box("secrets",image,["gitleaks","dir","--redact=100","--no-banner","--report-format=json",
            "--report-path=/reports/secrets.json","/source"],
            [(snapshot,"/source",False),(CACHE/"logs","/reports",True)],environment={"GOMAXPROCS":"2"},seconds=120)
    finally:
        shutil.rmtree(snapshot)


def cleanup():
    for kind in FIXTURES:
        if fixture_exists(kind): docker("rm","-f",FIXTURES[kind])


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action",choices=("prepare","backend","frontend","edge","sql","secrets","all","cleanup"))
    parser.add_argument("targets",nargs="*")
    args=parser.parse_args()
    if args.action=="prepare":prepare()
    elif args.action=="cleanup":cleanup()
    elif args.action=="all":
        for kind in ("backend","frontend","edge","sql","secrets"):verify(kind,[])
    else:verify(args.action,args.targets)
