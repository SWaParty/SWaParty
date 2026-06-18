package org.swaparty.rmstate.model;

public record InternalUser(
    String userId,
    String displayName,
    String avatarUrl
) {
  public String safeDisplayName() {
    String value = displayName == null ? "" : displayName.trim();
    return value.isEmpty() ? "SWaParty User" : value;
  }
}
