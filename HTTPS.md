# HTTPS

## Зачем

Часть модулей браузер даёт только защищённой странице — открытой по https или
с `localhost`. Нам критичен **WebCodecs (`VideoDecoder`)**: им редактор видео
разжимает кадры. По голому http (например `http://172.25.78.169:8899`) его в
браузере нет, и разметка видео не открывается с ошибкой «браузер не умеет
разжимать видео покадрово». Версия Chrome тут ни при чём.

По http недоступны и `crypto.randomUUID`, буфер обмена, service worker — фронт
их пока не использует.

Проверено безголовым Chrome: по http `isSecureContext: false` и `VideoDecoder`
нет; по https с самоподписанным сертификатом после «Перейти на сайт
(небезопасно)» — есть, и после перезагрузки тоже.

## Как устроено

Шлюз (nginx в `yolo-frontend`) подключает `/etc/nginx/tls/*.conf` — строка
`include` в [frontend/nginx.conf](frontend/nginx.conf). Каталог не смонтирован
(разработка) — всё как раньше, голый http.

## Сертификат

Самоподписанный, на адрес, по которому заходят (IP или имя — в `subjectAltName`):

```bash
ADDR=172.25.78.169
mkdir -p ~/magistral-tls && cd ~/magistral-tls
openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -keyout key.pem -out cert.pem \
  -subj "/CN=$ADDR" -addext "subjectAltName=IP:$ADDR"   # для имени: DNS:имя
cat > tls.conf <<'EOF'
listen 443 ssl;
ssl_certificate     /etc/nginx/tls/cert.pem;
ssl_certificate_key /etc/nginx/tls/key.pem;
# голый http на этот же порт — сразу на https того же адреса
error_page 497 =301 https://$http_host$request_uri;
EOF
```

## docker-compose.override.yml

```yaml
services:
  auth:
    environment:
      - APP_BASE_URL=https://172.25.78.169:8899
      - COOKIE_SECURE=1
  frontend:
    ports: !override
      - "8899:443"
    volumes:
      - /home/voran/magistral-tls:/etc/nginx/tls:ro
```

- `8899:443` — снаружи прежний порт, внутри TLS. Старые ссылки `http://…:8899`
  nginx сам уводит на https (`error_page 497`). Свободен 443 — можно `"443:443"`;
  на voran его держит дашборд wazuh.
- `COOKIE_SECURE=1` — кука сессии ходит только по https; после включения все
  входят заново.
- `APP_BASE_URL` — ссылки в письмах ведут на https-адрес.
- Каталог `~/magistral-tls` обязан существовать до `up`: иначе docker создаст
  пустой, nginx не станет слушать 443, и сайт пропадёт.

## Выкладка и проверка

```bash
docker compose build frontend && docker compose up -d frontend auth
docker exec yolo-frontend grep -c nginx/tls /etc/nginx/conf.d/default.conf   # 1 — образ не из старого кеша
docker exec yolo-frontend nginx -t
curl -sk -o /dev/null -w "%{http_code}\n" https://127.0.0.1:8899/            # 200
curl -s  -o /dev/null -w "%{redirect_url}\n" http://127.0.0.1:8899/          # https://127.0.0.1:8899/
```

Межсетевой экран включён — открыть порт (`sudo ufw allow 8899/tcp`).

## В браузере

Первый вход — предупреждение о сертификате: «Дополнительно → Перейти на сайт
(небезопасно)». Дальше всё работает.

Без HTTPS на сервере обойтись можно только на каждой машине отдельно:
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` → вписать
`http://172.25.78.169:8899` → Enabled → Relaunch.
