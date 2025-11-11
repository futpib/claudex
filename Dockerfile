FROM node:24-alpine

# Build arguments for user configuration
ARG USER_ID=1000
ARG USERNAME=claude

# Install system dependencies
RUN apk add --no-cache git bash

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create non-root user (remove existing user with same UID if present)
RUN (deluser node || true) && adduser -D -u ${USER_ID} ${USERNAME}

# Switch to non-root user
USER ${USERNAME}

# Entrypoint
ENTRYPOINT ["claude"]
