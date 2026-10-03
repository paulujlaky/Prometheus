// Push only: the app needs the server to be useful, so there is nothing worth caching for offline.

self.addEventListener("push", (event) => {

  const notice = event.data ? event.data.json() : { title: "Prometheus", body: "" };

  event.waitUntil(self.registration.showNotification(notice.title, {

    body: notice.body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",

    // one notification per agent; a newer one replaces the older
    tag: notice.agentId ? `agent-${notice.agentId}` : "prometheus",
    data: { url: notice.agentId ? `/#/agent/${notice.agentId}` : "/" },

  }));

});

self.addEventListener("notificationclick", (event) => {

  event.notification.close();

  const url = event.notification.data?.url ?? "/";

  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {

    const open = clients[0];

    if (open) {

      open.navigate(url);
      return open.focus();

    }

    return self.clients.openWindow(url);

  }));

});
