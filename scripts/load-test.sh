#!/bin/bash
set -e

TARGET_URL=${1:-"http://localhost:3000"}
echo "🔥 부하테스트 시작..."
echo "Target: $TARGET_URL"

if ! command -v artillery &> /dev/null; then
  echo "Artillery 설치 중..."
  npm install -g artillery
fi

# ⬇️ 따옴표 없는 heredoc(EOL) → Bash가 $TARGET_URL 확장함
cat > load-test-scenario.yml << EOL
config:
  target: "$TARGET_URL"
  phases:
    - duration: 30
      arrivalRate: 5
      name: "워밍업"
    - duration: 120
      arrivalRate: 25
      name: "설날 예매 러시"
    - duration: 30
      arrivalRate: 10
      name: "안정화"
scenarios:
  - name: "KTX 예매 시도"
    weight: 100
    flow:
      - post:
          url: "/api/book-ktx"
          json:
            route: "서울 → 부산"
            date: "2025-02-09"
            passengers: 1
      - think: 2
      - get:
          url: "/api/queue-status"
EOL

artillery run load-test-scenario.yml
rm -f load-test-scenario.yml
echo "🎯 부하테스트 완료!"
