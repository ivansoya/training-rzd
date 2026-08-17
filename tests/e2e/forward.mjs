import net from "node:net";

/**
 * Проброс стенда на localhost.
 *
 * Разжатие кадров держится на WebCodecs, а он живёт только в защищённом
 * контексте: HTTPS или localhost. Стенд отвечает по http на имя контейнера,
 * поэтому браузер считал бы страницу небезопасной и `VideoDecoder` бы просто
 * отсутствовал. Поднимать ради тестов TLS — лишнее; проще, чтобы тот же nginx
 * отзывался и на localhost.
 *
 * Подменять разрешение имени в браузере нельзя: часть запросов тесты делают
 * не из страницы, а из Node, и он про эту подмену не знает. Настоящий сокет
 * на 127.0.0.1 одинаково виден обоим.
 *
 * В настоящей работе это значит, что приложению нужен HTTPS.
 */
const target = new URL(process.env.TEST_BASE_URL || "http://frontend");
const port = Number(process.env.TEST_LOCAL_PORT || 8099);

const server = net.createServer((client) => {
  const upstream = net.connect(Number(target.port || 80), target.hostname);
  const drop = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on("error", drop);
  upstream.on("error", drop);
  client.pipe(upstream);
  upstream.pipe(client);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`localhost:${port} → ${target.host}`);
});
