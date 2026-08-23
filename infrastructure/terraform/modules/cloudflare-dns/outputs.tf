output "hostname" {
  value       = length(cloudflare_record.staging) > 0 ? cloudflare_record.staging[0].hostname : ""
  description = "The fully qualified hostname created in Cloudflare"
}

output "record_id" {
  value       = length(cloudflare_record.staging) > 0 ? cloudflare_record.staging[0].id : ""
  description = "The Cloudflare DNS record ID"
}
