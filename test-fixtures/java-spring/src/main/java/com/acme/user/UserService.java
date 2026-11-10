package com.acme.user;

import org.springframework.stereotype.Service;

@Service
public class UserService {

    /** Looks up one user. Called by the controller and by the order module. */
    public String getUser(String id) {
        return "user-" + id;
    }

    public String formatName(String name) {
        return name.trim().toUpperCase();
    }
}
