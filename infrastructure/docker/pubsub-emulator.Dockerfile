FROM gcr.io/google.com/cloudsdktool/google-cloud-cli:slim

RUN apt-get update \
  && apt-get install --no-install-recommends --yes google-cloud-cli-pubsub-emulator \
  && rm -rf /var/lib/apt/lists/*
