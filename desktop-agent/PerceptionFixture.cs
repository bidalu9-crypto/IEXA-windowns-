using System.Text.Json;
using System.Windows.Forms;

namespace Iexa.PerceptionFixture;

sealed class FixtureForm : Form
{
    readonly TextBox input = new() { Name = "messageInput", AccessibleName = "消息输入框" };
    readonly ListBox messages = new() { Name = "messageList", AccessibleName = "已发送消息" };
    readonly Label status = new() { Name = "statusLabel", Text = "READY", AutoSize = true };
    readonly string? logPath;

    public FixtureForm(string? logPath)
    {
        this.logPath = logPath;
        Text = "IEXA Desktop Control Fixture";
        ClientSize = new Size(760, 520);
        StartPosition = FormStartPosition.CenterScreen;
        MinimumSize = new Size(640, 430);
        Font = new Font("Microsoft YaHei UI", 10);

        var header = new Label
        {
            Text = "文件传输助手",
            AccessibleName = "文件传输助手",
            Font = new Font(Font.FontFamily, 15, FontStyle.Bold),
            AutoSize = true,
            Location = new Point(28, 24),
        };
        messages.Location = new Point(28, 72);
        messages.Size = new Size(704, 330);
        messages.Anchor = AnchorStyles.Top | AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        input.Location = new Point(28, 426);
        input.Size = new Size(590, 34);
        input.Anchor = AnchorStyles.Bottom | AnchorStyles.Left | AnchorStyles.Right;
        var send = new Button
        {
            Name = "sendButton",
            AccessibleName = "发送",
            Text = "发送",
            Location = new Point(632, 424),
            Size = new Size(100, 38),
            Anchor = AnchorStyles.Bottom | AnchorStyles.Right,
        };
        status.Location = new Point(28, 478);
        status.Anchor = AnchorStyles.Bottom | AnchorStyles.Left;
        send.Click += (_, _) => SendMessage();
        input.KeyDown += (_, e) =>
        {
            if (e.KeyCode != Keys.Enter) return;
            e.SuppressKeyPress = true;
            SendMessage();
        };
        Controls.AddRange([header, messages, input, send, status]);
        Shown += (_, _) => input.Focus();
    }

    void SendMessage()
    {
        var text = input.Text.Trim();
        if (text.Length == 0) return;
        messages.Items.Add(text);
        messages.TopIndex = messages.Items.Count - 1;
        input.Clear();
        status.Text = $"SENT:{text}";
        if (!string.IsNullOrWhiteSpace(logPath))
        {
            var record = JsonSerializer.Serialize(new { text, sentAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() });
            File.AppendAllText(logPath, record + Environment.NewLine);
        }
    }
}

static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        var logPath = args.Length > 0 ? Path.GetFullPath(args[0]) : null;
        var form = new FixtureForm(logPath);
        if (args.Length > 1 && !string.IsNullOrWhiteSpace(args[1])) form.Text = args[1];
        Application.Run(form);
    }
}
