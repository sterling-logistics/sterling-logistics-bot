namespace SterlingTracker;

internal sealed class DispatchShell : Form
{
    private readonly DispatchApiClient _api = new();
    private readonly MainForm _tracker = new();
    private readonly ComboBox _driver = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly TextBox _cargo = new() { Dock = DockStyle.Fill };
    private readonly TextBox _origin = new() { Dock = DockStyle.Fill };
    private readonly TextBox _destination = new() { Dock = DockStyle.Fill };
    private readonly NumericUpDown _minMiles = new() { Minimum = 0, Maximum = 100000, DecimalPlaces = 1, Dock = DockStyle.Fill };
    private readonly DateTimePicker _deadline = new() { Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd HH:mm", ShowCheckBox = true, Dock = DockStyle.Fill };
    private readonly TextBox _notes = new() { Multiline = true, Height = 54, Dock = DockStyle.Fill };
    private readonly Label _staffStatus = new() { Text = "Sign in on the Tracker tab, then refresh Dispatch.", Dock = DockStyle.Fill, ForeColor = Color.Gainsboro, TextAlign = ContentAlignment.MiddleLeft };
    private readonly DataGridView _grid = new() { Dock = DockStyle.Fill, ReadOnly = true, AllowUserToAddRows = false, AllowUserToDeleteRows = false, SelectionMode = DataGridViewSelectionMode.FullRowSelect, MultiSelect = false, AutoGenerateColumns = false, BackgroundColor = Color.FromArgb(9,18,31), ForeColor = Color.White, RowHeadersVisible = false };
    private readonly Button _create = Btn("Create & Assign Job");
    private readonly Button _refresh = Btn("Refresh Dispatch");
    private readonly Button _cancel = Btn("Cancel Selected");
    private readonly Button _reassign = Btn("Reassign Selected");
    private readonly Label _message = new() { Dock = DockStyle.Fill, ForeColor = Color.Gainsboro, TextAlign = ContentAlignment.MiddleLeft };

    public DispatchShell()
    {
        Text = "Sterling Dispatch — Staff Edition 1.0.0";
        Size = new Size(1360, 900);
        MinimumSize = new Size(1100, 760);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7,15,27);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        var trackerTab = new TabPage("Driver Tracker") { BackColor = BackColor };
        var dispatchTab = new TabPage("Dispatch / Staff") { BackColor = BackColor, Padding = new Padding(12) };
        tabs.TabPages.Add(trackerTab); tabs.TabPages.Add(dispatchTab);
        Controls.Add(tabs);

        _tracker.TopLevel = false;
        _tracker.FormBorderStyle = FormBorderStyle.None;
        _tracker.Dock = DockStyle.Fill;
        trackerTab.Controls.Add(_tracker);
        _tracker.Show();

        BuildDispatch(dispatchTab);
        _refresh.Click += async (_,_) => await RefreshAsync();
        _create.Click += async (_,_) => await CreateAsync();
        _cancel.Click += async (_,_) => await CancelAsync();
        _reassign.Click += async (_,_) => await ReassignAsync();
        tabs.SelectedIndexChanged += async (_,_) => { if (tabs.SelectedTab == dispatchTab) await RefreshAsync(); };
        FormClosing += (_,_) => { try { _tracker.Close(); } catch { } _api.Dispose(); };
    }

    private void BuildDispatch(Control host)
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 245));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));
        host.Controls.Add(root);

        var top = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 2 };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 180));
        top.Controls.Add(_staffStatus,0,0); top.Controls.Add(_refresh,1,0); root.Controls.Add(top,0,0);

        var createCard = new GroupBox { Text = "CREATE DRIVER ASSIGNMENT", Dock = DockStyle.Fill, ForeColor = Color.White, Padding = new Padding(10) };
        var form = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 4 };
        form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115)); form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50)); form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 115)); form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 50));
        Add(form,0,"Driver",_driver); Add(form,1,"Cargo",_cargo); Add(form,2,"Origin",_origin); Add(form,3,"Destination",_destination);
        form.Controls.Add(Label("Min miles"),0,2); form.Controls.Add(_minMiles,1,2); form.Controls.Add(Label("Deadline"),2,2); form.Controls.Add(_deadline,3,2);
        form.Controls.Add(Label("Notes"),0,3); form.Controls.Add(_notes,1,3); form.SetColumnSpan(_notes,2); form.Controls.Add(_create,3,3);
        createCard.Controls.Add(form); root.Controls.Add(createCard,0,1);

        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Job", DataPropertyName="WorkCode", Width=105 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Driver", DataPropertyName="Driver", Width=190 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Cargo", DataPropertyName="Cargo", Width=150 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Origin", DataPropertyName="Origin", Width=120 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Destination", DataPropertyName="Destination", Width=120 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Status", DataPropertyName="Status", Width=105 });
        _grid.Columns.Add(new DataGridViewCheckBoxColumn { HeaderText="Tracker", DataPropertyName="TrackerVerified", Width=70 });
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Miles", DataPropertyName="ActualMiles", Width=75, DefaultCellStyle = new DataGridViewCellStyle { Format="N1" } });
        root.Controls.Add(_grid,0,2);

        var actions = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4 };
        actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170)); actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170));
        actions.Controls.Add(_message,0,0); actions.Controls.Add(_reassign,2,0); actions.Controls.Add(_cancel,3,0); root.Controls.Add(actions,0,3);
    }

    private async Task RefreshAsync()
    {
        SetBusy(true);
        try
        {
            if (!await _api.IsStaffAsync()) throw new UnauthorizedAccessException("This profile is not authorised for Sterling Dispatch.");
            var drivers = await _api.GetDriversAsync();
            var current = _driver.SelectedItem as DispatchDriver;
            _driver.DataSource = drivers;
            if (current is not null) _driver.SelectedItem = drivers.FirstOrDefault(x=>x.Id==current.Id);
            _grid.DataSource = await _api.GetAssignmentsAsync("active");
            _staffStatus.Text = $"Dispatch authorised • {drivers.Count} active drivers";
            _message.Text = $"Updated {DateTime.Now:HH:mm:ss}";
        }
        catch (Exception ex) { _staffStatus.Text = ex.Message; _message.Text = "Dispatch unavailable"; }
        finally { SetBusy(false); }
    }

    private async Task CreateAsync()
    {
        if (_driver.SelectedItem is not DispatchDriver d) { MessageBox.Show("Select a driver first."); return; }
        if (String.IsNullOrWhiteSpace(_cargo.Text) || String.IsNullOrWhiteSpace(_origin.Text) || String.IsNullOrWhiteSpace(_destination.Text)) { MessageBox.Show("Cargo, origin and destination are required."); return; }
        SetBusy(true);
        try
        {
            var code = await _api.CreateAssignmentAsync(d.Id,_cargo.Text.Trim(),_origin.Text.Trim(),_destination.Text.Trim(),(double)_minMiles.Value,_deadline.Checked?_deadline.Value:null,_notes.Text.Trim());
            _message.Text = $"Created {code} for {d.SterlingDriverId}";
            _cargo.Clear(); _origin.Clear(); _destination.Clear(); _notes.Clear(); _minMiles.Value=0; _deadline.Checked=false;
            await RefreshAsync();
        }
        catch(Exception ex){MessageBox.Show(ex.Message,"Sterling Dispatch",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
        finally{SetBusy(false);}
    }

    private DispatchAssignment? Selected() => _grid.CurrentRow?.DataBoundItem as DispatchAssignment;

    private async Task CancelAsync()
    {
        var w=Selected(); if(w is null){MessageBox.Show("Select an assignment first.");return;}
        if(MessageBox.Show($"Cancel {w.WorkCode}?","Sterling Dispatch",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
        try{await _api.CancelAsync(w.WorkCode,"Cancelled in Sterling Dispatch Staff Edition");await RefreshAsync();}catch(Exception ex){MessageBox.Show(ex.Message);}
    }

    private async Task ReassignAsync()
    {
        var w=Selected(); if(w is null||_driver.SelectedItem is not DispatchDriver d){MessageBox.Show("Select an assignment and the new driver.");return;}
        try{await _api.ReassignAsync(w.WorkCode,d.Id);_message.Text=$"{w.WorkCode} reassigned to {d.SterlingDriverId}";await RefreshAsync();}catch(Exception ex){MessageBox.Show(ex.Message);}
    }

    private void SetBusy(bool busy){_create.Enabled=!busy;_refresh.Enabled=!busy;_cancel.Enabled=!busy;_reassign.Enabled=!busy;}
    private static Label Label(string t)=>new(){Text=t,Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Color.Gainsboro};
    private static Button Btn(string t)=>new(){Text=t,Dock=DockStyle.Fill,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(31,92,151),ForeColor=Color.White,FlatAppearance={BorderSize=0},Margin=new Padding(4)};
    private static void Add(TableLayoutPanel f,int row,string name,Control c){var col=row%2*2;var r=row/2;f.Controls.Add(Label(name),col,r);f.Controls.Add(c,col+1,r);}
}
