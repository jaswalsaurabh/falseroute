terraform {
  backend "gcs" {
    # Supply bucket and prefix through a private backend.hcl file at init time.
  }
}
