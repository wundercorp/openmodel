resource "cloudflare_workers_kv_namespace" "gateway_registry" {
  account_id = var.cloudflare_account_id
  title      = var.gateway_registry_namespace_title

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_dns_record" "web" {
  count = var.manage_custom_domains ? 1 : 0

  zone_id = var.cloudflare_zone_id
  name    = var.web_hostname
  content = "${var.pages_project_name}.pages.dev"
  type    = "CNAME"
  proxied = true
  ttl     = 1
}

resource "cloudflare_pages_domain" "web" {
  count = var.manage_custom_domains ? 1 : 0

  account_id   = var.cloudflare_account_id
  project_name = var.pages_project_name
  name         = var.web_hostname

  depends_on = [cloudflare_dns_record.web]
}

resource "cloudflare_workers_custom_domain" "api" {
  count = var.manage_custom_domains ? 1 : 0

  account_id  = var.cloudflare_account_id
  zone_id     = var.cloudflare_zone_id
  hostname    = var.api_hostname
  service     = var.worker_service_name
}
