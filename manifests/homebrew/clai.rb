class Clai < Formula
  desc "Cross-platform terminal AI assistant with ask and agent modes"
  homepage "https://github.com/aniketpandey/clai"
  version "0.1.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/aniketpandey/clai/releases/download/v0.1.0/clai-bun-darwin-arm64"
      sha256 "TO_BE_FILLED_BY_RELEASE_WORKFLOW"
    else
      url "https://github.com/aniketpandey/clai/releases/download/v0.1.0/clai-bun-darwin-x64"
      sha256 "TO_BE_FILLED_BY_RELEASE_WORKFLOW"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/aniketpandey/clai/releases/download/v0.1.0/clai-bun-linux-arm64"
      sha256 "TO_BE_FILLED_BY_RELEASE_WORKFLOW"
    else
      url "https://github.com/aniketpandey/clai/releases/download/v0.1.0/clai-bun-linux-x64"
      sha256 "TO_BE_FILLED_BY_RELEASE_WORKFLOW"
    end
  end

  def install
    bin.install Dir["clai-*"].first => "clai"
  end

  test do
    system "#{bin}/clai", "--version"
  end
end
