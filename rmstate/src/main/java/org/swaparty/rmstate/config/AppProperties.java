package org.swaparty.rmstate.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "swaparty")
public record AppProperties(
    String internalApiToken,
    String corsAllowedOrigins,
    Realtime realtime,
    RoomLifecycle roomLifecycle
) {
  public record Realtime(String publishUrl, String publishToken) {
  }

  public record RoomLifecycle(long hostDisconnectGraceSeconds, long cleanupFixedDelayMs) {
  }
}
