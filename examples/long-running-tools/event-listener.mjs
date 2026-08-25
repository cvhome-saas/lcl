const args = process.argv.slice(2);
const forwardIndex = args.indexOf('--forward-to');
const target = forwardIndex >= 0 ? args[forwardIndex + 1] : undefined;
const intervalMs = Number(process.env.EVENT_INTERVAL_MS ?? 5000);

if (!target || !URL.canParse(target)) {
    console.error('usage: node event-listener.mjs --forward-to <url>');
    process.exit(2);
}
if (!Number.isFinite(intervalMs) || intervalMs < 100) {
    console.error('EVENT_INTERVAL_MS must be a number of at least 100');
    process.exit(2);
}

let sequence = 0;
async function forwardEvent() {
    sequence += 1;
    const event = { id: `evt_${sequence}`, type: 'payment.succeeded' };
    try {
        const response = await fetch(target, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(2000)
        });
        console.log(`forwarded ${event.id}: HTTP ${response.status}`);
    } catch (error) {
        console.error(`failed to forward ${event.id}: ${error.message}`);
    }
}

console.log(`event listener ready; forwarding to ${target}`);
void forwardEvent();
const timer = setInterval(() => void forwardEvent(), intervalMs);

function stop() {
    clearInterval(timer);
    process.exit(0);
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);
