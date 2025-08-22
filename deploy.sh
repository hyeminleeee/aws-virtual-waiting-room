#!/bin/bash
# scripts/deploy-aws.sh - 완전 자동화된 AWS 배포 스크립트

set -e

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 환경 변수
AWS_REGION=${AWS_REGION:-"ap-northeast-2"}
STACK_NAME="KtxWaitingRoomStack"
PROJECT_NAME="ktx-waiting-room"

print_status "🚀 KTX Virtual Waiting Room AWS 배포 시작..."
print_status "리전: $AWS_REGION"
print_status "스택명: $STACK_NAME"

# 현재 디렉토리 확인
if [[ ! -f "docker-compose.yml" ]]; then
    print_error "docker-compose.yml 파일이 없습니다. 프로젝트 루트 디렉토리에서 실행해주세요."
    exit 1
fi

# 1. 사전 검사
print_status "📋 사전 환경 검사..."

# AWS CLI 확인
if ! command -v aws &> /dev/null; then
    print_error "AWS CLI가 설치되지 않았습니다."
    exit 1
fi

# Docker 확인
if ! command -v docker &> /dev/null; then
    print_error "Docker가 설치되지 않았습니다."
    exit 1
fi

# CDK 확인
if ! command -v cdk &> /dev/null; then
    print_error "AWS CDK가 설치되지 않았습니다. 'npm install -g aws-cdk' 실행하세요."
    exit 1
fi

# AWS 자격증명 확인
if ! aws sts get-caller-identity &> /dev/null; then
    print_error "AWS 자격증명이 설정되지 않았습니다. 'aws configure' 실행하세요."
    exit 1
fi

AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
print_success "사전 검사 완료 - AWS 계정: $AWS_ACCOUNT_ID"

# 2. 로컬 테스트 실행
print_status "🧪 로컬 환경 테스트..."

# Docker Compose로 로컬 테스트
print_status "Docker Compose 로컬 테스트 시작..."
docker-compose down --remove-orphans 2>/dev/null || true
docker-compose up -d

# 헬스체크 대기
print_status "서비스 준비 대기 중..."
sleep 30

# Backend 헬스체크
if curl -f http://localhost:3000/health >/dev/null 2>&1; then
    print_success "Backend 서비스 정상"
else
    print_error "Backend 서비스 비정상. 로컬 테스트 실패"
    docker-compose logs backend
    exit 1
fi

# Frontend 헬스체크
if curl -f http://localhost >/dev/null 2>&1; then
    print_success "Frontend 서비스 정상"
else
    print_warning "Frontend 서비스 확인 필요"
fi

print_success "로컬 테스트 완료"

# 3. AWS 인프라 배포
print_status "🏗️ AWS 인프라 배포..."

cd aws-infra

# 의존성 설치
if [[ ! -d "node_modules" ]]; then
    print_status "CDK 의존성 설치 중..."
    npm install
fi

# CDK 부트스트랩 (최초 1회)
print_status "CDK 부트스트랩 확인..."
if ! aws cloudformation describe-stacks --stack-name CDKToolkit --region $AWS_REGION >/dev/null 2>&1; then
    print_status "CDK 부트스트랩 실행 중..."
    cdk bootstrap aws://$AWS_ACCOUNT_ID/$AWS_REGION
else
    print_status "CDK 부트스트랩 이미 완료됨"
fi

# 인프라 배포
print_status "CloudFormation 스택 배포 중..."
cdk deploy --require-approval never --region $AWS_REGION

# 배포 결과 확인
if aws cloudformation describe-stacks --stack-name $STACK_NAME --region $AWS_REGION >/dev/null 2>&1; then
    print_success "인프라 배포 완료"
else
    print_error "인프라 배포 실패"
    exit 1
fi

cd ..

# 4. ECR 리포지토리 URI 가져오기
print_status "📦 ECR 리포지토리 정보 조회..."

BACKEND_ECR_URI=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`BackendECRRepository`].OutputValue' \
    --output text)

FRONTEND_ECR_URI=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`FrontendECRRepository`].OutputValue' \
    --output text)

if [[ -z "$BACKEND_ECR_URI" || -z "$FRONTEND_ECR_URI" ]]; then
    print_error "ECR URI 조회 실패"
    exit 1
fi

print_status "Backend ECR: $BACKEND_ECR_URI"
print_status "Frontend ECR: $FRONTEND_ECR_URI"

# 5. ECR 로그인
print_status "🔑 ECR 로그인..."
aws ecr get-login-password --region $AWS_REGION | \
    docker login --username AWS --password-stdin $AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com

if [[ $? -ne 0 ]]; then
    print_error "ECR 로그인 실패"
    exit 1
fi

# 6. Docker 이미지 빌드 및 푸시
print_status "🐳 Docker 이미지 빌드 및 푸시..."

# Backend 이미지
print_status "Backend 이미지 빌드 중..."
cd backend
docker build -t $PROJECT_NAME-backend .
docker tag $PROJECT_NAME-backend:latest $BACKEND_ECR_URI:latest

print_status "Backend 이미지 푸시 중..."
docker push $BACKEND_ECR_URI:latest

if [[ $? -ne 0 ]]; then
    print_error "Backend 이미지 푸시 실패"
    exit 1
fi

cd ..

# Frontend 이미지
print_status "Frontend 이미지 빌드 중..."
cd frontend
docker build -t $PROJECT_NAME-frontend .
docker tag $PROJECT_NAME-frontend:latest $FRONTEND_ECR_URI:latest

print_status "Frontend 이미지 푸시 중..."
docker push $FRONTEND_ECR_URI:latest

if [[ $? -ne 0 ]]; then
    print_error "Frontend 이미지 푸시 실패"
    exit 1
fi

cd ..

print_success "Docker 이미지 배포 완료"

# 7. ECS 서비스 업데이트
print_status "🔄 ECS 서비스 업데이트..."

# Backend 서비스 업데이트
aws ecs update-service \
    --cluster ktx-waiting-room-cluster \
    --service ktx-backend-service \
    --force-new-deployment \
    --region $AWS_REGION >/dev/null

# Frontend 서비스 업데이트
aws ecs update-service \
    --cluster ktx-waiting-room-cluster \
    --service ktx-frontend-service \
    --force-new-deployment \
    --region $AWS_REGION >/dev/null

# 8. 배포 완료 대기
print_status "⏳ 서비스 배포 완료 대기..."
aws ecs wait services-stable \
    --cluster ktx-waiting-room-cluster \
    --services ktx-backend-service ktx-frontend-service \
    --region $AWS_REGION

# 9. 최종 결과 확인
print_status "✅ 배포 상태 확인..."

# ALB DNS 이름 가져오기
ALB_DNS=$(aws cloudformation describe-stacks \
    --stack-name $STACK_NAME \
    --region $AWS_REGION \
    --query 'Stacks[0].Outputs[?OutputKey==`LoadBalancerDNS`].OutputValue' \
    --output text)

# 헬스체크
print_status "헬스체크 수행 중..."
sleep 60  # 서비스 준비 시간

# Backend 헬스체크
if curl -f "http://$ALB_DNS/health" >/dev/null 2>&1; then
    print_success "✅ Backend 서비스 정상"
else
    print_warning "⚠️ Backend 서비스 아직 준비 중... (몇 분 더 기다려주세요)"
fi

# Frontend 헬스체크
if curl -f "http://$ALB_DNS" >/dev/null 2>&1; then
    print_success "✅ Frontend 서비스 정상"
else
    print_warning "⚠️ Frontend 서비스 아직 준비 중... (몇 분 더 기다려주세요)"
fi

# 로컬 Docker Compose 정리
print_status "🧹 로컬 환경 정리..."
docker-compose down

# 10. 배포 완료 정보 출력
print_success "🎉 AWS 배포 완료!"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🌐 서비스 URL:"
echo "   Website:      http://$ALB_DNS"
echo "   API:          http://$ALB_DNS/api/queue-status"
echo "   Health:       http://$ALB_DNS/health"
echo ""
echo "📊 AWS 리소스:"
echo "   ECS Cluster:  ktx-waiting-room-cluster"
echo "   Backend ECR:  $BACKEND_ECR_URI"
echo "   Frontend ECR: $FRONTEND_ECR_URI"
echo "   Region:       $AWS_REGION"
echo "   Stack:        $STACK_NAME"
echo ""
echo "🔧 관리 명령어:"
echo "   AWS 콘솔:     https://$AWS_REGION.console.aws.amazon.com/ecs/home"
echo "   로그 확인:    aws logs tail /ecs/ktx-waiting-room-backend --follow --region $AWS_REGION"
echo "   스케일링:     aws ecs update-service --cluster ktx-waiting-room-cluster --service ktx-backend-service --desired-count 4 --region $AWS_REGION"
echo ""
echo "🔥 부하테스트:"
echo "   artillery quick --count 200 --num 20 http://$ALB_DNS/api/book-ktx"
echo ""
echo "🛑 리소스 삭제:"
echo "   cd aws-infra && cdk destroy --region $AWS_REGION"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# 성공 사운드 (macOS)
if command -v afplay &> /dev/null; then
    afplay /System/Library/Sounds/Hero.aiff 2>/dev/null || true
fi

print_success "배포 스크립트 완료! 🚀"