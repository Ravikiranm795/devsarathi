package com.acme.user;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class UserServiceTest {

    @Test
    void formatsNames() {
        UserService service = new UserService();
        assertEquals("ADA", service.formatName("  ada "));
    }
}
