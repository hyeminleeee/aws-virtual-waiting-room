#!/bin/bash

echo "🧹 리소스 정리 시작..."

# 로컬 Docker 정리
echo "로컬 Docker 컨테이너 정리..."
docker-compose down --remove-orphans --volumes 2>/dev/null || true

# Docker 이미지 정리
echo "Docker 이미지 정리..."
docker system prune -f

# AWS 리소스 정리 (선택사항)
read -p "AWS 리소스도 삭제하시겠습니까? (y/N): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "AWS 리소스 삭제 중..."
    cd aws-infra
    cdk destroy --force
    cd ..
    echo "✅ AWS 리소스 삭제 완료"
fi

echo "🎉 정리 완료!"
