variable "aws_region" {
  description = "AWS region for Lambda, API Gateway, DynamoDB, S3, and the CloudFront certificate. Use us-east-1 for this stack."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "This stack currently requires aws_region to be us-east-1 so one ACM certificate can serve CloudFront and the regional API Gateway domain."
  }
}

variable "aws_profile" {
  description = "Optional AWS shared-config profile. Leave empty to use the normal AWS credential chain or CI OIDC."
  type        = string
  default     = ""
}

variable "expected_aws_account_id" {
  description = "Expected AWS account identifier. Terraform stops if the active credentials belong to another account."
  type        = string
  default     = ""
}

variable "route53_zone_id" {
  description = "Existing public Route 53 hosted zone identifier for openmodel.sh."
  type        = string
}

variable "project_name" {
  description = "Stable resource-name prefix."
  type        = string
  default     = "openmodel"
}

variable "web_hostname" {
  description = "Production website hostname."
  type        = string
  default     = "openmodel.sh"
}

variable "api_hostname" {
  description = "Production cloud API hostname."
  type        = string
  default     = "api.openmodel.sh"
}

variable "auth_issuer" {
  description = "OIDC issuer accepted by the cloud API."
  type        = string
  default     = "https://auth.wundercorp.co"
}

variable "auth_audience" {
  description = "OIDC audience accepted by the cloud API."
  type        = string
  default     = "https://api.openmodel.sh"
}

variable "allowed_origins" {
  description = "Comma-separated browser origins accepted by the cloud API."
  type        = string
  default     = "https://openmodel.sh"
}

variable "lambda_bundle_file" {
  description = "Absolute path to the built AWS Lambda entry file."
  type        = string
}

variable "cloudfront_price_class" {
  description = "CloudFront price class."
  type        = string
  default     = "PriceClass_100"
}

variable "log_retention_days" {
  description = "CloudWatch log retention."
  type        = number
  default     = 30
}

variable "force_destroy_web_bucket" {
  description = "Whether Terraform may delete a non-empty website bucket. Keep false in production."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to supported AWS resources."
  type        = map(string)
  default = {
    Application = "openmodel"
    ManagedBy   = "terraform"
  }
}
