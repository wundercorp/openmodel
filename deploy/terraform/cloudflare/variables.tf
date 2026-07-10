variable "cloudflare_account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "cloudflare_zone_id" {
  description = "Cloudflare zone identifier for the OpenModel domain."
  type        = string
}

variable "manage_custom_domains" {
  description = "Whether Terraform should attach the production website and API hostnames."
  type        = bool
  default     = true
}

variable "web_hostname" {
  description = "Production hostname for the website."
  type        = string
  default     = "openmodel.sh"
}

variable "api_hostname" {
  description = "Production hostname for the cloud API."
  type        = string
  default     = "api.openmodel.sh"
}

variable "pages_project_name" {
  description = "Cloudflare Pages project created by Wrangler before Terraform attaches its domain."
  type        = string
  default     = "openmodel-web"
}

variable "worker_service_name" {
  description = "Cloudflare Worker service deployed by Wrangler before Terraform attaches its custom domain."
  type        = string
  default     = "openmodel-cloud"
}

variable "gateway_registry_namespace_title" {
  description = "Cloudflare KV namespace title for contributed gateway metadata."
  type        = string
  default     = "openmodel-gateway-registry"
}
