#!/bin/bash
# End-to-end season-separation checks against a live server.
#
# Usage:  FF_SESSION=<your ff_session cookie> BASE=http://localhost:3000 bash scripts/season-checks.sh
#
# Read-mostly, but the lifecycle section DOES write: it starts a "Fall 2027"
# season and enrolls players into it. Run it against a copy of league.db, not
# the live one, unless you actually want those changes.
C="Cookie: ff_session=${FF_SESSION:?set FF_SESSION to a valid session token from your browser cookies}"; B=${BASE:-http://localhost:3000}; J='Content-Type: application/json'
pass=0; fail=0
chk(){ # chk <label> <expected> <actual>
  if [ "$2" == "$3" ]; then echo "  PASS  $1 → $3"; pass=$((pass+1));
  else echo "  FAIL  $1 → got '$3', want '$2'"; fail=$((fail+1)); fi
}
jq_(){ python3 -c "import json,sys;d=json.load(sys.stdin);print($1)" 2>/dev/null || echo "ERR"; }

echo "== baseline scoping =="
chk "Fall 2023 players" 414 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2023' | jq_ "len(d['records'])")"
chk "Fall 2026 players" 0   "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2026' | jq_ "len(d['records'])")"
chk "all seasons"       414 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: *' | jq_ "len(d['records'])")"
chk "no header→active"  414 "$(curl -s "$B/api/records?type=player" -H "$C" | jq_ "len(d['records'])")"
chk "(no season)"       0   "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: (no season)' | jq_ "len(d['records'])")"

echo "== stale-scope hazard: an unbound route must not leak the previous request's season =="
curl -s -o /dev/null "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2026'
chk "state after F2026 req, asking F2023" 414 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2023' | jq_ "len(d['records'])")"
curl -s -o /dev/null "$B/api/health" -H "$C" -H 'x-ff-season: Fall 2026'
chk "after health(F2026), records(F2023)" 414 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2023' | jq_ "len(d['records'])")"

echo "== divisions / master / unassigned are season-scoped =="
chk "divisions F2023" 6 "$(curl -s "$B/api/divisions" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2023' -d '{"action":"list"}' | jq_ "len(d.get('divisions',d))")"
chk "divisions F2026" 0 "$(curl -s "$B/api/divisions" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2026' -d '{"action":"list"}' | jq_ "len(d.get('divisions',d))")"
chk "master F2023" 414 "$(curl -s "$B/api/master" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2023' -d '{"action":"summary","type":"player"}' | jq_ "d['total']")"
chk "master F2026" 0   "$(curl -s "$B/api/master" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2026' -d '{"action":"summary","type":"player"}' | jq_ "d['total']")"
chk "unassigned F2023 no_division" 2 "$(curl -s "$B/api/unassigned" -H "$C" -H 'x-ff-season: Fall 2023' | jq_ "d['counts']['no_division']")"

echo "== lifecycle =="
chk "start Fall 2027" started "$(curl -s "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"start","name":"Fall 2027","leagues":["Saturday Limerick"],"copy_setup_from":"Fall 2023"}' | jq_ "d['status']")"
chk "copied divisions" 6 "$(curl -s "$B/api/divisions" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2027' -d '{"action":"list"}' | jq_ "len(d.get('divisions',d))")"
chk "enroll dry-run count" 304 "$(curl -s "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"enroll","from_season":"Fall 2023","to_season":"Fall 2027","league":"Saturday Limerick","dry_run":true}' | jq_ "d['would_enroll']")"
chk "enroll real" 304 "$(curl -s "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"enroll","from_season":"Fall 2023","to_season":"Fall 2027","league":"Saturday Limerick"}' | jq_ "d['enrolled']")"
chk "enroll twice = 0 new" 0 "$(curl -s "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"enroll","from_season":"Fall 2023","to_season":"Fall 2027","league":"Saturday Limerick"}' | jq_ "d['enrolled']")"
chk "source season intact" 414 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2023' | jq_ "len(d['records'])")"
chk "new season populated" 304 "$(curl -s "$B/api/records?type=player" -H "$C" -H 'x-ff-season: Fall 2027' | jq_ "len(d['records'])")"
chk "new season unassigned total" 304 "$(curl -s "$B/api/unassigned" -H "$C" -H 'x-ff-season: Fall 2027' | jq_ "d['total']")"

echo "== locking =="
curl -s -o /dev/null "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"lock","name":"Fall 2023"}'
chk "locked move refused" 1 "$(curl -s "$B/api/roster" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2023' -d '{"action":"move","id":364,"changes":{"team":"X"}}' | jq_ "1 if 'locked' in str(d.get('error','')) else 0")"
chk "locked create refused" 1 "$(curl -s "$B/api/records" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2023' -d '{"type":"player","name":"Ghost","fields":{"full_name":"Ghost","age":9}}' | jq_ "1 if 'locked' in str(d.get('error','')) else 0")"
chk "other season still writable" 1 "$(curl -s "$B/api/roster" -X POST -H "$C" -H "$J" -H 'x-ff-season: Fall 2027' -d '{"action":"move","id":999999,"changes":{"team":"X"}}' | jq_ "1 if 'not found' in str(d.get('error','')).lower() else 0")"
curl -s -o /dev/null "$B/api/seasons" -X POST -H "$C" -H "$J" -d '{"action":"unlock","name":"Fall 2023"}'

echo "== exports =="
for spec in "season=Fall%202027&league=Saturday%20Limerick&scope=league&format=xlsx|xlsx" \
            "season=Fall%202027&scope=season&format=xlsx|xlsx" \
            "season=Fall%202023&league=Sunday%20Upper%20Merion&scope=league&format=zip|zip" \
            "season=Fall%202023&scope=season&format=csv&sheet=All%20Players|csv"; do
  q="${spec%|*}"; kind="${spec#*|}"
  code=$(curl -s -o "/tmp/e2e-$kind.bin" -w "%{http_code}" "$B/api/export?$q" -H "$C")
  sz=$(stat -c%s "/tmp/e2e-$kind.bin")
  chk "export $kind (${sz}b)" 200 "$code"
done
chk "export bad league refused" 400 "$(curl -s -o /dev/null -w '%{http_code}' "$B/api/export?season=Fall%202027&league=Nope&scope=league" -H "$C")"

echo "== cleanup report =="
chk "orphans after migration" 0 "$(curl -s "$B/api/seasons?report=cleanup" -H "$C" | jq_ "d['orphan_total']")"
chk "flags the Wedn typo" 1 "$(curl -s "$B/api/seasons?report=cleanup" -H "$C" | jq_ "1 if 'Wedn' in d['options'].get('player.league',[]) else 0")"

echo
echo "PASS=$pass FAIL=$fail"
