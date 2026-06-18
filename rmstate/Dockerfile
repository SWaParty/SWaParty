FROM maven:3.9-eclipse-temurin-21 AS build

WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /workspace/target/rmstate-0.1.0.jar /app/rmstate.jar

EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/rmstate.jar"]
