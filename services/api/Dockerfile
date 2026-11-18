FROM golang:1.25-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /api ./cmd/api

FROM alpine:3.21
RUN addgroup -S mailpilot && adduser -S -G mailpilot mailpilot
COPY --from=build --chown=mailpilot:mailpilot /api /api
COPY --chown=mailpilot:mailpilot migrations /migrations
USER mailpilot
EXPOSE 8080
CMD ["/api"]
