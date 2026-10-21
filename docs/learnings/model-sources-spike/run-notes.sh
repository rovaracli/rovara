# Harness for docs/learnings/model-sources-spike.md. Not a script to run blindly: these are the commands that were run.
# Needs: colima/docker, the pinned LiteLLM image, postgres:16, python3, Node 22 + tsx (Pi driver). Files in this folder:
#   mock.py          wire mock upstream (Anthropic Messages, OpenAI Responses and Completions; streaming, tools, usage with cache/reasoning
#                    tokens; HTTPS on 8443 with cert.pem/key.pem from `openssl req -x509 -newkey rsa:2048 -nodes -subj /CN=ms-mock`;
#                    /redir/<code>/<kind>/... routes; canary listener on 9100). Run inside the LiteLLM image: python /spike/mock.py
#   rovara_guard.py  the Q8/Q9 guard: per-route field allow-list, header refusals, no-redirect patch, start-up self-test
#   config-guard.yaml proxy config with the guard and user_api_key_cache_ttl: 10 (copy rovara_guard.py next to it as /app/rovara_guard.py)
#   drive.py         request driver + admin helpers (reads the master key from ./mk.txt)
#   setup_orgs.py    two org aliases, teams and keys
#   hooktest.py      refusal matrix + replay of Pi's captured bodies:  python3 hooktest.py http://localhost:14005 <key> <msgAlias>,<respAlias>,<ccAlias>
#   q9.py            redirect matrix: python3 q9.py <B|C>   (C = stock proxy, B = guarded)
#   mint.py          mint-time validation + post-mint verification prototype
#   pi-driver.mts.txt drives the repo's real Pi runtime (pi-ai 1.0.0) through a proxy and records every request
# Two replicas share one Postgres; STORE_MODEL_IN_DB=True; the same LITELLM_SALT_KEY on both; LITELLM_LOCAL_MODEL_COST_MAP=True.
