using System.Text;
using System.Text.Json;
using System.Net.Http.Headers;

var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

string VERIFY_TOKEN = Environment.GetEnvironmentVariable("VERIFY_TOKEN") ?? "ED_WA_Verify_2025";
string WA_TOKEN = Environment.GetEnvironmentVariable("WA_TOKEN") ?? "";
string PHONE_NUMBER_ID = Environment.GetEnvironmentVariable("PHONE_NUMBER_ID") ?? "";

app.MapGet("/WhatsAppWebhook", (HttpRequest req) =>
{
    var mode = req.Query["hub.mode"];
    var token = req.Query["hub.verify_token"];
    var challenge = req.Query["hub.challenge"];

    if (mode == "subscribe" && token == VERIFY_TOKEN)
        return Results.Text(challenge);

    return Results.StatusCode(403);
});

app.MapPost("/WhatsAppWebhook", async (HttpRequest req) =>
{
    using var reader = new StreamReader(req.Body, Encoding.UTF8);
    var body = await reader.ReadToEndAsync();

    Console.WriteLine("=== WEBHOOK RECIBIDO ===");
    Console.WriteLine(body);

    if (string.IsNullOrWhiteSpace(body))
        return Results.Ok();

    using var json = JsonDocument.Parse(body);
    var root = json.RootElement;

    var entry = root.GetProperty("entry")[0];
    var changes = entry.GetProperty("changes")[0];
    var value = changes.GetProperty("value");

    if (!value.TryGetProperty("messages", out var messages))
        return Results.Ok();

    var msg = messages[0];
    var from = msg.GetProperty("from").GetString();
    var text = msg.GetProperty("text").GetProperty("body").GetString() ?? "";

    var reply = text.Trim().Equals("AYUDA", StringComparison.OrdinalIgnoreCase)
        ? "Hola 👋 soy *E&D Assistant*.\n\nOpciones disponibles:\n• RSVP\n• ITINERARIO\n• MÚSICA\n• MAPA"
        : "Gracias por tu mensaje 💕\nEscribe *AYUDA* para ver las opciones.";

    using var http = new HttpClient();
    http.DefaultRequestHeaders.Authorization =
        new AuthenticationHeaderValue("Bearer", WA_TOKEN);

    var payload = new
    {
        messaging_product = "whatsapp",
        to = from,
        type = "text",
        text = new { body = reply }
    };

    var jsonPayload = JsonSerializer.Serialize(payload);
    var content = new StringContent(jsonPayload, Encoding.UTF8, "application/json");

    var url = $"https://graph.facebook.com/v21.0/{PHONE_NUMBER_ID}/messages";
    await http.PostAsync(url, content);

    return Results.Ok();
});

app.Run();
