export const DEFAULT_SANDBOX_DOCKERFILE = `FROM public.ecr.aws/s5i7k8t3/strongdm/coder:latest

RUN apt-get update && apt-get install -y --no-install-recommends \
      unzip \
      jq \
      pipx \
      openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Pre-seed GitHub SSH host key so git-over-SSH works without prompts
RUN mkdir -p /root/.ssh \
    && ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# AWS CLI v2
RUN curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-$(uname -m).zip" -o /tmp/awscli.zip \
    && unzip -q /tmp/awscli.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/awscli.zip

# Snowflake CLI
RUN pipx install --include-deps snowflake-cli-labs \
    && ln -sf /root/.local/bin/snow /usr/local/bin/snow

# Jira CLI
RUN JIRA_VERSION=\$(curl -fsSL https://api.github.com/repos/ankitpokhrel/jira-cli/releases/latest \
      | grep '"tag_name"' | sed 's/.*"v\\([^"]*\\)".*/\\1/') \
    && ARCH=\$(uname -m | sed 's/x86_64/x86_64/;s/aarch64/arm64/') \
    && curl -fsSL "https://github.com/ankitpokhrel/jira-cli/releases/download/v\${JIRA_VERSION}/jira_\${JIRA_VERSION}_linux_\${ARCH}.tar.gz" \
      | tar -xz -C /tmp \
    && mv /tmp/jira_\${JIRA_VERSION}_linux_\${ARCH}/bin/jira /usr/local/bin/jira \
    && rm -rf /tmp/jira_*

# GitHub Copilot CLI
RUN curl -fsSL https://gh.io/copilot-install | bash

# Bun
RUN curl -fsSL https://bun.sh/install | bash \
    && ln -sf /root/.bun/bin/bun /usr/local/bin/bun

# uv (Python package manager)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh \
    && ln -sf /root/.local/bin/uv /usr/local/bin/uv

# pnpm via Corepack
RUN corepack enable
`
