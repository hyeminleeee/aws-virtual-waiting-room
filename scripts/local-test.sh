#!/bin/bash
set -e

echo "🧪 로컬 테스트 시작..."

# Docker Desktop 실행 확인
if ! docker info >/dev/null 2>&1; then
    echo "❌ Docker Desktop이 실행되지 않았습니다."
    echo "Docker Desktop을 시작하고 다시 시도해주세요."
    exit 1
fi

# package-lock.json 파일 확인
if [ ! -f frontend/package-lock.json ] || [ ! -f backend/package-lock.json ]; then
    echo "📦 의존성 파일이 없습니다. 재설정을 실행합니다..."
    ./scripts/reset-and-setup.sh
fi

# 기존 컨테이너 정리
echo "🧹 기존 컨테이너 정리..."
docker-compose down --remove-orphans 2>/dev/null || true

# 이미지도 정리 (캐시 문제 방지)
echo "🧹 Docker 이미지 정리..."
docker-compose build --no-cache

# 단계별 서비스 시작
echo "🚀 서비스 시작..."

# Redis 먼저 시작
echo "  - Redis 시작 중..."
docker-compose up -d redis
sleep 15

# Backend 시작
echo "  - Backend 시작 중..."
docker-compose up -d backend
sleep 45

# Backend 헬스체크
echo "🏥 Backend 헬스체크..."
for i in {1..20}; do
    if curl -f http://localhost:3000/health >/dev/null 2>&1; then
        echo "✅ Backend 서비스 정상"
        break
    fi
    if [ $i -eq 20 ]; then
        echo "❌ Backend 헬스체크 실패"
        echo ""
        echo "Backend 로그:"
        docker-compose logs backend
        echo ""
        echo "컨테이너 상태:"
        docker-compose ps
        exit 1
    fi
    echo "  시도 $i/20... (Backend 시작 대기 중)"
    sleep 5
done

# Frontend 시작
echo "  - Frontend 시작 중..."
docker-compose up -d frontend
sleep 30

# Frontend 헬스체크
echo "🏥 Frontend 헬스체크..."
for i in {1..10}; do
    if curl -f http://localhost >/dev/null 2>&1; then
        echo "✅ Frontend 서비스 정상"
        break
    fi
    if [ $i -eq 10 ]; then
        echo "⚠️ Frontend 서비스 확인 필요"
        echo "Frontend 로그:"
        docker-compose logs frontend
    fi
    echo "  시도 $i/10... (Frontend 시작 대기 중)"
    sleep 3
done

echo ""
echo "🎉 로컬 테스트 완료!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 웹사이트: http://localhost"
echo "🔗 API 상태: http://localhost:3000/api/queue-status"
echo "🏥 헬스체크: http://localhost:3000/health"
echo ""
echo "📊 컨테이너 상태 확인:"
echo "  docker-compose ps"
echo ""
echo "📋 로그 확인:"
echo "  docker-compose logs backend"
echo "  docker-compose logs frontend"
echo ""
echo "🔥 부하테스트:"
echo "  ./scripts/load-test.sh http://localhost:3000"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
