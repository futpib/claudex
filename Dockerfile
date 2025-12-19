FROM archlinux:latest

# Build arguments for user configuration
ARG USER_ID=1000
ARG USERNAME=claude

# Install system dependencies
RUN pacman -Syu --noconfirm git bash nodejs npm base-devel sudo ripgrep fd jq openssh

# Install yay
RUN set -xe; \
	useradd -m -G wheel builder; \
	echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers; \
	su - builder -c 'git clone https://aur.archlinux.org/yay.git && cd yay && makepkg -si --noconfirm'; \
	userdel -r builder

# Create non-root user
RUN set -xe; \
	useradd -m -u ${USER_ID} -G wheel ${USERNAME}; \
	mkdir -p /home/${USERNAME}/.config /home/${USERNAME}/.local/bin /home/${USERNAME}/.local/share; \
	chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Install AUR packages if specified
ARG PACKAGES=""
RUN set -xe; \
	if [ -n "${PACKAGES}" ]; then \
		pacman -Syu --noconfirm; \
		useradd -m -G wheel builder; \
		su - builder -c "yay -S --noconfirm ${PACKAGES}"; \
		userdel -r builder; \
	fi

# Switch to non-root user
USER ${USERNAME}

# Configure npm to use user-local prefix for global installs
RUN mkdir -p /home/${USERNAME}/.local/share/npm-global && \
	npm config set prefix /home/${USERNAME}/.local/share/npm-global
ENV PATH="/home/${USERNAME}/.local/share/npm-global/bin:${PATH}"

# Install Claude Code CLI
ARG CLAUDE_CODE_VERSION
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Disable sudo for user
USER root
RUN gpasswd -d ${USERNAME} wheel || true
USER ${USERNAME}
