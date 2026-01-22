# Stage 1: Install Claude Code
FROM archlinux:latest AS claude-code-installer
RUN pacman -Syu --noconfirm curl
RUN curl -fsSL https://claude.ai/install.sh | bash

# Stage 2: Main image
FROM archlinux:latest

# Build arguments for user configuration
ARG USER_ID=1000
ARG USERNAME=claude

# Install system dependencies (as root)
RUN pacman -Syu --noconfirm git bash base-devel sudo ripgrep fd jq openssh

# Install yay (as root, using temp builder user)
RUN set -xe; \
	useradd -m -G wheel builder; \
	echo '%wheel ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers; \
	su - builder -c 'git clone https://aur.archlinux.org/yay.git && cd yay && makepkg -si --noconfirm'; \
	userdel -r builder

# Install AUR packages if specified (as root, using temp builder user)
ARG PACKAGES=""
RUN set -xe; \
	if [ -n "${PACKAGES}" ]; then \
		pacman -Syu --noconfirm; \
		useradd -m -G wheel builder; \
		su - builder -c "yay -S --noconfirm ${PACKAGES}"; \
		userdel -r builder; \
	fi

# Copy Claude Code installation from first stage
COPY --from=claude-code-installer /root/.local/bin/claude /opt/claude-code/.local/bin/claude
COPY --from=claude-code-installer /root/.local/share/claude /opt/claude-code/.local/share/claude

# Create non-root user WITHOUT sudo access
RUN set -xe; \
	useradd -m -u ${USER_ID} ${USERNAME}; \
	mkdir -p /home/${USERNAME}/.config /home/${USERNAME}/.local/bin /home/${USERNAME}/.local/share; \
	chown -R ${USERNAME}:${USERNAME} /home/${USERNAME}

# Switch to non-root user (no sudo from this point)
USER ${USERNAME}
ENV PATH="/opt/claude-code/.local/bin:/home/${USERNAME}/.local/bin:${PATH}"
