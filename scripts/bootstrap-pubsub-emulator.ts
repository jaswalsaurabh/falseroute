const host = process.env.PUBSUB_EMULATOR_HOST ?? '127.0.0.1:8085';
const projectId = process.env.PUBSUB_PROJECT_ID ?? 'falseroute-local';
const topicId = process.env.PUBSUB_TOPIC_ID ?? 'falseroute-events';
const workerPushEndpoint =
  process.env.PUBSUB_PUSH_ENDPOINT ?? 'http://host.docker.internal:8088/pubsub/push';
const deadLetterPushEndpoint =
  process.env.PUBSUB_DEAD_LETTER_PUSH_ENDPOINT ??
  'http://host.docker.internal:8088/pubsub/dead-letter';
const baseUrl = `http://${host}`;

async function request(path: string, init?: RequestInit, attempt = 1): Promise<Response> {
  try {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (response.ok || response.status === 409) return response;
  } catch {
    // The emulator may still be starting; retry within the bounded startup window.
  }
  if (attempt >= 30) throw new Error(`Pub/Sub emulator did not become ready at ${baseUrl}`);
  await new Promise((resolve) => setTimeout(resolve, 500));
  return request(path, init, attempt + 1);
}

async function createTopic(id: string): Promise<void> {
  await request(`/v1/projects/${projectId}/topics/${id}`, { method: 'PUT' });
}

async function createSubscription(
  id: string,
  subscriptionTopic: string,
  options: {
    pushEndpoint?: string;
    deadLetterTopic?: string;
  } = {},
) {
  const body = {
    topic: `projects/${projectId}/topics/${subscriptionTopic}`,
    ackDeadlineSeconds: 60,
    ...(options.pushEndpoint ? { pushConfig: { pushEndpoint: options.pushEndpoint } } : {}),
    ...(options.deadLetterTopic
      ? {
          deadLetterPolicy: {
            deadLetterTopic: `projects/${projectId}/topics/${options.deadLetterTopic}`,
            maxDeliveryAttempts: 5,
          },
        }
      : {}),
  };
  await request(`/v1/projects/${projectId}/subscriptions/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

await createTopic(topicId);
await createTopic(`${topicId}-dead-letter`);
await createSubscription(`${topicId}-sub`, topicId, {
  pushEndpoint: workerPushEndpoint,
  deadLetterTopic: `${topicId}-dead-letter`,
});
await createSubscription(`${topicId}-dead-letter-sub`, `${topicId}-dead-letter`, {
  pushEndpoint: deadLetterPushEndpoint,
});
process.stdout.write(
  `[pubsub-emulator] ready: project=${projectId} topic=${topicId} push=${workerPushEndpoint} deadLetter=${deadLetterPushEndpoint}\n`,
);
