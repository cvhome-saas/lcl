import { createServer } from 'node:http';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('usage: node payment.mjs <port>');
    process.exit(2);
}

const message = process.env.PAYMENT_MESSAGE ?? 'webhook accepted';
const server = createServer(async (request, response) => {
    if (request.url === '/health') {
        response.end('UP');
        return;
    }

    if (request.method === 'POST' && request.url === '/webhook') {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        console.log(`received webhook: ${Buffer.concat(chunks).toString('utf8')}`);
        response.writeHead(202, { 'content-type': 'text/plain' });
        response.end(message);
        return;
    }

    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end(message);
});

server.listen(port, '127.0.0.1', () => console.log(`payment ready on ${port}`));

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
