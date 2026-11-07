#!/usr/bin/env python3
"""Query OSV for installed Python, locked npm and direct browser dependencies.

Reads distribution metadata only. It never imports application/dependency code,
runs install hooks, or sends source, credentials or environment values.
"""
import argparse
import hashlib
from datetime import datetime, timezone
import importlib.metadata
import json
from pathlib import Path
import re
import sys
import urllib.request

ROOT=Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--packages",type=Path,default=ROOT/".security-test/python")
args=parser.parse_args()
if not args.packages.is_dir():raise SystemExit("Prepare the test dependency directory first.")
if args.packages.resolve()==(ROOT/".security-test/python").resolve():
    try:prepared=json.loads((ROOT/".security-test/prepared.json").read_text())
    except (FileNotFoundError,ValueError):raise SystemExit("Complete dependency preparation first.")
    for relative,digest in prepared["inputs"].items():
        if hashlib.sha256((ROOT/relative).read_bytes()).hexdigest()!=digest:
            raise SystemExit("Dependency inputs changed. Run preparation again.")
records={}


def add(name,version,ecosystem):
    if not isinstance(name,str) or not re.fullmatch(r"[@A-Za-z0-9][A-Za-z0-9_./@-]{0,199}",name):
        raise SystemExit("Unexpected package metadata name.")
    if not isinstance(version,str) or not re.fullmatch(r"[A-Za-z0-9.+!-]{1,100}",version):
        raise SystemExit("Unexpected package metadata version.")
    records[(ecosystem,name.lower(),version)]={"package":{"name":name,"ecosystem":ecosystem},"version":version}


installed=set()
for distribution in importlib.metadata.distributions(path=[str(args.packages)]):
    add(distribution.metadata["Name"],distribution.version,"PyPI")
    installed.add(re.sub(r"[-_.]+","-",distribution.metadata["Name"]).lower())
required={re.sub(r"[-_.]+","-",match[1]).lower() for line in (ROOT/"backend/requirements.txt").read_text().splitlines()
    if (match:=re.match(r"^([A-Za-z0-9_.-]+)",line))}
if required-installed:raise SystemExit("Incomplete installed metadata: "+", ".join(sorted(required-installed)))
lock=json.loads((ROOT/"frontend/package-lock.json").read_text())
for path,entry in lock.get("packages",{}).items():
    if "node_modules/" in path and entry.get("version"):
        add(entry.get("name") or path.rsplit("node_modules/",1)[1],entry["version"],"npm")
for path in (ROOT/"frontend/js/components/markdown.js",ROOT/"frontend/js/supabaseClient.js"):
    for match in re.finditer(r'https://(?:esm\.sh/|cdn\.jsdelivr\.net/npm/)([^\s"\x27]+)',path.read_text()):
        package,_,tail=match[1].rpartition("@")
        version=tail.split("/",1)[0].split("?",1)[0]
        if not re.fullmatch(r"\d+\.\d+\.\d+",version):raise SystemExit("Browser dependencies need exact reviewed versions.")
        add(package,version,"npm")
vendor=json.loads((ROOT/"frontend/vendor/dompurify/PROVENANCE.json").read_text())
add(vendor["name"],vendor["version"],"npm")
queries=list(records.values())
request=urllib.request.Request("https://api.osv.dev/v1/querybatch",data=json.dumps({"queries":queries}).encode(),headers={"Content-Type":"application/json"})
try:
    with urllib.request.urlopen(request,timeout=30) as response:
        raw=response.read(4_000_001)
        if len(raw)>4_000_000:raise ValueError("Response too large")
        results=json.loads(raw)["results"]
    if len(results)!=len(queries):raise ValueError("Incomplete response")
except Exception as error:
    raise SystemExit("Advisory lookup unavailable: "+type(error).__name__)
report={"checked_at":datetime.now(timezone.utc).isoformat(),"source":"https://osv.dev/","packages":[]}
failed=False
for query,result in zip(queries,results):
    ids=[v["id"] for v in result.get("vulns",[])]
    report["packages"].append({**query,"advisories":ids})
    if ids:
        failed=True
        print(query["package"]["name"],query["version"],", ".join(ids))
destination=ROOT/".security-test/logs/dependency-audit.json"
destination.parent.mkdir(parents=True,exist_ok=True)
destination.write_text(json.dumps(report,indent=2)+"\n")
print(f"Checked {len(queries)} package versions. Report: {destination}")
sys.exit(1 if failed else 0)
