FROM maven:3.9.9-eclipse-temurin-21

WORKDIR /app

# Copy only pom first (for caching)
COPY pom.xml .

RUN mvn -B -q -e -DskipTests dependency:go-offline

# Copy source
COPY src ./src

# Build jar
RUN mvn clean package -DskipTests

# Run app
CMD ["java", "-jar", "target/jchain-backend-1.0.0.jar"]