using System.Windows;

namespace Sterling.Logistics.Tracker;

public partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();
        StatusText.Text = "Ready to connect.";
    }

    private void SignInButton_Click(object sender, RoutedEventArgs e)
    {
        var username = UsernameBox.Text.Trim();
        if (string.IsNullOrWhiteSpace(username) || string.IsNullOrWhiteSpace(PasswordBox.Password))
        {
            StatusText.Text = "Enter your Sterling username and password.";
            return;
        }

        StatusText.Text = "Login UI ready. Secure API authentication is the next integration step.";
    }
}
