# Alert Analyzer AgentCore runtime image. Build context is agents/ so shared code
# (analyzer/retry.py, reused by the publisher) is reachable from one place.
# AgentCore Runtime requires linux/arm64; BedrockAgentCoreApp serves on port 8080.
# The pure logic (triage.py, retry.py) is unit-tested off the image.
FROM --platform=linux/arm64 python:3.12-slim

WORKDIR /app

COPY analyzer/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY analyzer/app.py analyzer/triage.py analyzer/retry.py ./

EXPOSE 8080
CMD ["python", "app.py"]
