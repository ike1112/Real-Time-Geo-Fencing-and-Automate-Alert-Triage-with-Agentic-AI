# Alert Publisher AgentCore runtime image. Build context is agents/ so it can pull
# in analyzer/retry.py (the shared Bedrock throttle backoff) without duplicating it.
# AgentCore Runtime requires linux/arm64; BedrockAgentCoreApp serves on port 8080.
# The pure logic (compose.py, idempotency.py) is unit-tested off the image.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app

COPY publisher/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY publisher/app.py publisher/compose.py publisher/idempotency.py analyzer/retry.py ./

EXPOSE 8080
CMD ["python", "app.py"]
