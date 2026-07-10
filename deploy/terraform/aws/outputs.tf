output "aws_account_id" {
  description = "AWS account receiving the deployment."
  value       = data.aws_caller_identity.current.account_id
}

output "website_bucket_name" {
  description = "S3 bucket containing the built website."
  value       = aws_s3_bucket.website.id
}

output "cloudfront_distribution_id" {
  description = "CloudFront distribution to invalidate after website uploads."
  value       = aws_cloudfront_distribution.website.id
}

output "cloudfront_domain_name" {
  description = "CloudFront diagnostic domain."
  value       = aws_cloudfront_distribution.website.domain_name
}

output "website_url" {
  description = "Production website URL."
  value       = "https://${var.web_hostname}"
}

output "api_url" {
  description = "Production API URL."
  value       = "https://${var.api_hostname}"
}

output "api_gateway_default_url" {
  description = "API Gateway diagnostic URL."
  value       = aws_apigatewayv2_api.api.api_endpoint
}

output "gateway_registry_table_name" {
  description = "DynamoDB gateway-registry table."
  value       = aws_dynamodb_table.gateway_registry.name
}
