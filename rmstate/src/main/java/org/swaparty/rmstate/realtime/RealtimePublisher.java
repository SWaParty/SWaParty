package org.swaparty.rmstate.realtime;

import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.swaparty.rmstate.config.AppProperties;

@Component
public class RealtimePublisher {
  private static final Logger LOG = LoggerFactory.getLogger(RealtimePublisher.class);

  private final AppProperties properties;
  private final RestClient restClient;

  public RealtimePublisher(AppProperties properties, RestClient.Builder builder) {
    this.properties = properties;
    this.restClient = builder.build();
  }

  public void publish(String type, List<String> targets, Map<String, Object> payload) {
    AppProperties.Realtime realtime = properties.realtime();
    String url = realtime == null ? "" : trim(realtime.publishUrl());
    String token = realtime == null ? "" : trim(realtime.publishToken());
    if (url.isEmpty() || token.isEmpty() || targets == null || targets.isEmpty()) return;

    Map<String, Object> body = Map.of(
        "type", type,
        "targets", targets,
        "payload", payload == null ? Map.of() : payload,
        "ts", System.currentTimeMillis());

    try {
      restClient.post()
          .uri(url)
          .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
          .contentType(MediaType.APPLICATION_JSON)
          .body(body)
          .retrieve()
          .toBodilessEntity();
    } catch (Exception ex) {
      // Persistence is authoritative. Realtime delivery can be recovered by refresh.
      LOG.debug("Realtime publish failed for type={} targets={}", type, targets, ex);
    }
  }

  private static String trim(String value) {
    return value == null ? "" : value.trim();
  }
}
