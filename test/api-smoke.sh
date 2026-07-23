#!/usr/bin/env bash
set -euo pipefail

BASE="${1:-http://localhost:5000}"
KEY="${2:-admin-key-123}"
PASS=0
FAIL=0

green() { echo "  ✓ $1"; ((PASS++)); }
red() { echo "  ✗ $1"; ((FAIL++)); }

check_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    green "$label"
  else
    red "$label (expected $expected, got $actual)"
  fi
}

echo "=== Health ==="
HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/health")
check_status "GET /health" "200" "$HTTP"

echo "=== Auth ==="
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects")
check_status "GET /projects (auth)" "200" "$HTTP"

HTTP=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/v2/projects")
check_status "GET /projects (no auth)" "401" "$HTTP"

echo "=== Projects CRUD ==="
# Create
RESP=$(curl -s -X POST "$BASE/api/v2/projects" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Project","description":"Smoke test"}')
PROJ_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
PROJ_NAME=$(echo "$RESP" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v2/projects" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test Project","description":"Smoke test"}')
check_status "POST /projects (create)" "201" "$HTTP"
check_status "Project has id" "1" "$([ -n "$PROJ_ID" ] && echo 1 || echo 0)"
check_status "Project name correct" "Test Project" "$PROJ_NAME"

# List
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects")
check_status "GET /projects (list)" "200" "$HTTP"

# Get by ID
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects/$PROJ_ID")
check_status "GET /projects/:id" "200" "$HTTP"

# Update
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/api/v2/projects/$PROJ_ID" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Updated Project","description":"Updated"}')
check_status "PUT /projects/:id (update)" "200" "$HTTP"

RESP=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects/$PROJ_ID")
UPD_NAME=$(echo "$RESP" | grep -o '"name":"[^"]*"' | head -1 | cut -d'"' -f4)
check_status "Updated name" "Updated Project" "$UPD_NAME"

# Stats
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects/$PROJ_ID/stats")
check_status "GET /projects/:id/stats" "200" "$HTTP"

# Not found
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects/nonexistent")
check_status "GET /projects/:id (404)" "404" "$HTTP"

# Create without name
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v2/projects" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"description":"no name"}')
check_status "POST /projects (no name)" "400" "$HTTP"

# Delete
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v2/projects/$PROJ_ID" \
  -H "Authorization: Bearer $KEY")
check_status "DELETE /projects/:id" "204" "$HTTP"

# Verify deleted
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/projects/$PROJ_ID")
check_status "GET deleted project (404)" "404" "$HTTP"

echo "=== Sessions CRUD ==="
# Create a project first
RESP=$(curl -s -X POST "$BASE/api/v2/projects" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Session Test Project"}')
PROJ_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

# Create session
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v2/sessions" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Test Session\",\"project_id\":\"$PROJ_ID\"}")
check_status "POST /sessions (create)" "201" "$HTTP"

RESP=$(curl -s -X POST "$BASE/api/v2/sessions" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"name\":\"Test Session\",\"project_id\":\"$PROJ_ID\"}")
SESS_ID=$(echo "$RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
SESS_TITLE=$(echo "$RESP" | grep -o '"title":"[^"]*"' | head -1 | cut -d'"' -f4)
check_status "Session has id" "1" "$([ -n "$SESS_ID" ] && echo 1 || echo 0)"
check_status "Session title" "Test Session" "$SESS_TITLE"

# List sessions
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions")
check_status "GET /sessions (list)" "200" "$HTTP"

# Get by ID
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID")
check_status "GET /sessions/:id" "200" "$HTTP"

# Update session
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/api/v2/sessions/$SESS_ID" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Updated Session"}')
check_status "PATCH /sessions/:id (update)" "200" "$HTTP"

RESP=$(curl -s -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID")
UPD_TITLE=$(echo "$RESP" | grep -o '"title":"[^"]*"' | head -1 | cut -d'"' -f4)
check_status "Updated title" "Updated Session" "$UPD_TITLE"

# Get session status
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID/status")
check_status "GET /sessions/:id/status" "200" "$HTTP"

# Fork session
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v2/sessions/$SESS_ID/fork" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{}')
check_status "POST /sessions/:id/fork" "201" "$HTTP"

FORK_RESP=$(curl -s -X POST "$BASE/api/v2/sessions/$SESS_ID/fork" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' \
  -d '{}')
FORK_ID=$(echo "$FORK_RESP" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
check_status "Fork has id" "1" "$([ -n "$FORK_ID" ] && echo 1 || echo 0)"

# Get children
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID/children")
check_status "GET /sessions/:id/children" "200" "$HTTP"

# Get session tree
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID/tree")
check_status "GET /sessions/:id/tree" "200" "$HTTP"

# Clear session
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/v2/sessions/$SESS_ID/clear" \
  -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json')
check_status "POST /sessions/:id/clear" "200" "$HTTP"

# Not found
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/nonexistent")
check_status "GET /sessions/:id (404)" "404" "$HTTP"

# Delete session
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/v2/sessions/$SESS_ID" \
  -H "Authorization: Bearer $KEY")
check_status "DELETE /sessions/:id" "204" "$HTTP"

# Verify deleted
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $KEY" "$BASE/api/v2/sessions/$SESS_ID")
check_status "GET deleted session (404)" "404" "$HTTP"

# Cleanup: delete project
curl -s -X DELETE "$BASE/api/v2/projects/$PROJ_ID" -H "Authorization: Bearer $KEY" > /dev/null

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="
exit $FAIL
