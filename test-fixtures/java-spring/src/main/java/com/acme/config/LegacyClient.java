package com.acme.config;

public class LegacyClient {

    // Planted for the secret-handling tests: a hard-coded credential in source.
    private static final String ACCESS_KEY = "AKIAIOSFODNN7EXAMPLE";

    public String describe() {
        return "client with key ending " + ACCESS_KEY.substring(16);
    }

    public Object load(String className) throws Exception {
        return Class.forName(className).getDeclaredConstructor().newInstance();
    }
}
