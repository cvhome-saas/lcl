# Long-running tools

This runnable example combines an HTTP payment service with a portless event-listener process. The listener starts
only after the payment health check passes, receives the final allocated payment port in its command, forwards mock
webhooks, and becomes ready from a log marker. Neither Node.js script loads dotenv itself; LCL injects `.env` values.

```bash
cd examples/long-running-tools
cp .env.example .env
lcl validate
lcl start event-listener -d
lcl logs event-listener payment -f
lcl stop
```

Starting `event-listener` also selects its `payment` dependency. Run another named stack with
`lcl start event-listener -d --stack second` to see both services use the same whole-stack port offset.

To use Stripe CLI instead of the mock listener, replace only its command and use process readiness unless the local
CLI version has a stable readiness message:

```yaml
command:
  - stripe
  - listen
  - --forward-to
  - "http://127.0.0.1:${port.payment.http}/webhook"
health: { type: process, timeout: 10 }
```

Keep the tool in the foreground. Authenticate and configure it through its supported local mechanism; remember
that resolved service environment can appear in `lcl why` diagnostics.
