# frontend/Dockerfile
# 멀티 스테이지 빌드
FROM node:18-alpine AS builder

WORKDIR /app

# 패키지 파일 복사
COPY package*.json ./

# 의존성 설치 (npm install 사용 - 더 안전함)
RUN npm install

# 소스 코드 복사 및 빌드
COPY . .
RUN npm run build

# Nginx 스테이지
FROM nginx:alpine

# 빌드 프로필: local(로컬 프록시), ecs(운영, 프록시 없음)
# 기본값을 ecs로 두면 실수로 운영에 로컬 프록시가 들어가는 걸 방지
ARG PROFILE=ecs
ENV PROFILE=${PROFILE}

# 빌드된 파일 복사
COPY --from=builder /app/build /usr/share/nginx/html

# Nginx 설정을 프로필에 따라 선택 복사
# - nginx-local.conf : /api 프록시 포함 (로컬 docker-compose 용)
# - nginx-ecs.conf   : 프록시 제거 (ALB가 /api 라우팅)
COPY nginx-local.conf /etc/nginx/nginx-local.conf
COPY nginx-ecs.conf   /etc/nginx/nginx-ecs.conf

# 선택된 설정을 nginx.conf로 링크
# (PROFILE 값 검증 + 심플 스위치)
RUN if [ "$PROFILE" = "local" ]; then \
      cp /etc/nginx/nginx-local.conf /etc/nginx/nginx.conf; \
    else \
      cp /etc/nginx/nginx-ecs.conf /etc/nginx/nginx.conf; \
    fi

# 포트 노출
EXPOSE 80

# Nginx 실행
CMD ["nginx", "-g", "daemon off;"]
