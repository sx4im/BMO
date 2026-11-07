"""A fresh-process Flask worker for the isolated shared-counter tests."""
import argparse
import json
import time

import jwt

from app.auth import require_user
from app.limiter import limiter
from app.main import app

parser = argparse.ArgumentParser()
parser.add_argument("--requests", type=int, default=1)
parser.add_argument("--path", default="/rate-fixture")
args = parser.parse_args()


@app.get("/rate-fixture")
@limiter.limit("3 per minute")
@require_user
def fixture(user):
    return {"ok": True}


token = jwt.encode({"sub": "10000000-0000-0000-0000-000000000001", "aud": "authenticated",
                    "iss": "https://fixture.invalid/auth/v1", "exp": int(time.time()) + 300},
                   "fixture-rate-limit-key-at-least-32-bytes", algorithm="HS256")
with app.test_client() as client:
    responses = [client.get(args.path, headers={"Authorization": f"Bearer {token}", "X-Forwarded-For": f"192.0.2.{index+1}"}) for index in range(args.requests)]
print("BMO_RATE_RESULT=" + json.dumps([{"status": response.status_code, "detail": response.json.get("detail") if response.is_json else None} for response in responses]))
