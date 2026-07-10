output "gateway_registry_namespace_id" {
  description = "KV namespace identifier used in the generated Wrangler production configuration."
  value       = cloudflare_workers_kv_namespace.gateway_registry.id
}

output "website_url" {
  description = "Production website URL when custom domains are enabled."
  value       = var.manage_custom_domains ? "https://${var.web_hostname}" : "https://${var.pages_project_name}.pages.dev"
}

output "api_url" {
  description = "Production API URL when custom domains are enabled."
  value       = var.manage_custom_domains ? "https://${var.api_hostname}" : null
}
