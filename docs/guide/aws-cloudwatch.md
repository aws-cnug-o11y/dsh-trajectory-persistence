# AWS CloudWatch & Bedrock AgentCore Observability

Instead of a plain OTLP endpoint, the otel sink can sign each batch with
**AWS Signature Version 4** and POST it straight to the
[CloudWatch OTLP endpoint](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-OTLPEndpoint.html)
— the same ingest path Bedrock AgentCore Observability uses. No collector or
sidecar is required, and credentials come from the AWS default provider
chain.

## Minimal configuration

```yaml
config:
  sinks:
    otel:
      enabled: true
      aws:
        region: us-west-2
        # url: ~      # endpoint override — VPC endpoint or another partition
                        # (e.g. https://xray.cn-north-1.amazonaws.com.cn/v1/traces)
        # service: ~  # SigV4 service name override; defaults to xray
```

`aws` is mutually exclusive with `url` (it already implies its endpoint), and
`aws.region` is required. The full field table lives in the
[Configuration Reference](/guide/configuration#sinks-otel-aws).

## Endpoint facts

- The CloudWatch OTLP traces endpoint is
  `https://xray.<region>.amazonaws.com/v1/traces`, signed with the SigV4
  service name **`xray`**.
- It is **HTTP only** (no gRPC) and accepts both OTLP **protobuf** and **JSON**
  payloads; this plugin always sends protobuf (`application/x-protobuf`),
  serialized with the OTel SDK's own `ProtobufTraceSerializer` — the same
  serializer the upstream OTLP HTTP/protobuf exporter uses.
- Signing goes through `@smithy/signature-v4` — the same stack as
  `@aws-sdk/client-s3`, no hand-rolled HMAC chain.

## Credentials

Credentials come from the **AWS default provider chain** (`fromNodeProviderChain`)
— nothing to put in the config. Environment variables, shared config/credentials
files, ECS/EC2/… instance roles all work as usual.

For static credentials, use the environment:

```sh
export AWS_ACCESS_KEY_ID=<your-access-key-id>
export AWS_SECRET_ACCESS_KEY=<your-secret-access-key>
# export AWS_SESSION_TOKEN=<your-session-token>   # only for temporary credentials
```

The signing region is always `aws.region`; it must match the endpoint's region.

## China regions and other partitions

The default URL assumes the standard `amazonaws.com` partition. For the China
regions (or a VPC endpoint), override `aws.url` explicitly — the SigV4 service
name stays `xray`:

```yaml
config:
  sinks:
    otel:
      enabled: true
      aws:
        region: cn-north-1
        url: https://xray.cn-north-1.amazonaws.com.cn/v1/traces
```

`aws.service` is a further override for exotic setups; you should not need it
for CloudWatch.

## AgentCore Observability

Spans posted to the CloudWatch OTLP endpoint land in the CloudWatch
**`aws/spans`** log group, and the standard `gen_ai.*` span attributes this
sink already emits are recognized by the CloudWatch **GenAI observability
dashboard** — the same surface Bedrock AgentCore Observability reads.

To see them:

1. **Enable Transaction Search** in CloudWatch (XRay → Transaction Search).
   Without it, spans are not indexed into `aws/spans` and the GenAI dashboard
   stays empty.
2. Open the **GenAI observability** dashboard in CloudWatch; sessions appear
   keyed by `gen_ai.conversation.id` (= the dsh session id), with per-step
   model (`gen_ai.request.model`) and token usage (`gen_ai.usage.*`) from the
   [event → span mapping](/guide/otel-sink#event-genai-span-mapping).

## Notes

- Extra entries in `sinks.otel.headers` are merged into the signed request
  (custom headers win on conflict).
- Export failures surface in the plugin's logs; a non-2xx response includes
  the first 512 bytes of the AWS error body.
