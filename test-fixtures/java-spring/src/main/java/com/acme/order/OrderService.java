package com.acme.order;

import com.acme.user.UserService;
import org.springframework.stereotype.Service;

@Service
public class OrderService {

    private final UserService userService;

    public OrderService(UserService userService) {
        this.userService = userService;
    }

    public String ownerOf(String orderId) {
        return userService.getUser(orderId);
    }
}
