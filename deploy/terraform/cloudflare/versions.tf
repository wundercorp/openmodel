terraform {
  required_version = ">= 1.8.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.21.1"
    }
  }
}

provider "cloudflare" {}
