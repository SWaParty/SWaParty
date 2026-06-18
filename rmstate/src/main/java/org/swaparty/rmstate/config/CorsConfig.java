package org.swaparty.rmstate.config;

import java.util.Arrays;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.cors.UrlBasedCorsConfigurationSource;
import org.springframework.web.filter.CorsFilter;

@Configuration
public class CorsConfig {
  @Bean
  CorsFilter corsFilter(AppProperties properties) {
    CorsConfiguration config = new CorsConfiguration();
    config.setAllowCredentials(true);
    config.setAllowedMethods(Arrays.asList("GET", "POST", "OPTIONS"));
    config.setAllowedHeaders(Arrays.asList("Authorization", "Content-Type", "X-SWaParty-User-Id",
        "X-SWaParty-User-Name", "X-SWaParty-User-Avatar"));
    String origins = properties.corsAllowedOrigins() == null ? "" : properties.corsAllowedOrigins();
    config.setAllowedOrigins(Arrays.stream(origins.split(","))
        .map(String::trim)
        .filter(item -> !item.isEmpty())
        .toList());

    UrlBasedCorsConfigurationSource source = new UrlBasedCorsConfigurationSource();
    source.registerCorsConfiguration("/**", config);
    return new CorsFilter(source);
  }
}
