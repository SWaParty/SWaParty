package org.swaparty.rmstate.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.swaparty.rmstate.model.InternalUser;

@Component
public class InternalAuthFilter extends OncePerRequestFilter {
  public static final String USER_ATTRIBUTE = "swaparty.internalUser";

  private final AppProperties properties;

  public InternalAuthFilter(AppProperties properties) {
    this.properties = properties;
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    String path = request.getRequestURI();
    return !path.startsWith("/internal/");
  }

  @Override
  protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
      throws ServletException, IOException {
    String configured = trim(properties.internalApiToken());
    String auth = trim(request.getHeader("Authorization"));
    String token = auth.startsWith("Bearer ") ? auth.substring("Bearer ".length()).trim() : "";
    String userId = trim(request.getHeader("X-SWaParty-User-Id"));

    if (configured.isEmpty() || !constantTimeEquals(configured, token) || userId.isEmpty()) {
      response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
      response.setContentType(MediaType.APPLICATION_JSON_VALUE);
      response.getWriter().write("{\"ok\":false,\"error\":\"unauthorized\"}");
      return;
    }

    InternalUser user = new InternalUser(
        userId,
        trim(request.getHeader("X-SWaParty-User-Name")),
        trim(request.getHeader("X-SWaParty-User-Avatar")));
    request.setAttribute(USER_ATTRIBUTE, user);
    filterChain.doFilter(request, response);
  }

  private static String trim(String value) {
    return value == null ? "" : value.trim();
  }

  private static boolean constantTimeEquals(String left, String right) {
    if (left.length() != right.length()) return false;
    int diff = 0;
    for (int i = 0; i < left.length(); i += 1) {
      diff |= left.charAt(i) ^ right.charAt(i);
    }
    return diff == 0;
  }
}
