# AWS Terraform

This stack uses the existing Route 53 hosted zone for `openmodel.sh` and provisions:

- A private, versioned S3 website bucket
- CloudFront with origin access control and security headers
- ACM certificates validated through Route 53
- Route 53 alias records for `openmodel.sh` and `api.openmodel.sh`
- API Gateway HTTP API
- Node.js Lambda cloud API
- DynamoDB gateway registry
- IAM roles and retained CloudWatch logs

Run it through `./deploy.sh`. Do not create or replace the Route 53 hosted zone. Terraform manages only the application records inside the existing zone.
