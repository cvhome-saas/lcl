import { createServer } from 'node:http';

const name = process.argv[2];
const port = Number(process.argv[3]);
for (const key of process.argv.slice(4)) console.log(`${key}=${process.env[key] ?? '<unset>'}`);
const server = createServer((request, response) => {
    if (request.url === '/health') {
        response.setHeader('content-type', 'application/json');
        response.end('{"status":"UP"}');
        return;
    }
    response.end(name);
});

server.listen(port, '127.0.0.1', () => console.log(`${name} ready on ${port}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
