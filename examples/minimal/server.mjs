import { createServer } from 'node:http';

const port = Number(process.argv[2]);
createServer((request, response) => response.end(request.url === '/health' ? 'UP' : 'hello from lcl'))
    .listen(port, () => console.log(`ready on ${port}`));
