namespace SterlingTracker;

internal sealed class DispatchShell : Form
{
    private readonly DispatchApiClient _api = new();
    private readonly MainForm _tracker = new();
    private readonly ComboBox _driver = new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };
    private readonly ComboBox _cargo = Selector();
    private readonly ComboBox _origin = Selector();
    private readonly ComboBox _destination = Selector();
    private readonly ComboBox _assignmentFilter = Filter("All Jobs","Active","Assigned","In Progress","Completed","Cancelled");
    private readonly ComboBox _approvalFilter = Filter("All","Pending","Approved","Declined");
    private readonly ComboBox _payoutFilter = Filter("All","Pending","Applied");
    private readonly NumericUpDown _minMiles = new() { Minimum = 0, Maximum = 100000, DecimalPlaces = 1, Dock = DockStyle.Fill };
    private readonly DateTimePicker _deadline = new() { Format = DateTimePickerFormat.Custom, CustomFormat = "yyyy-MM-dd HH:mm", ShowCheckBox = true, Dock = DockStyle.Fill };
    private readonly TextBox _notes = new() { Multiline = true, Height = 54, Dock = DockStyle.Fill };
    private readonly Label _staffStatus = StatusLabel("Sign in on the Tracker tab, then refresh Dispatch.");
    private readonly DataGridView _grid = Grid();
    private readonly Button _create = Btn("Create & Assign Job");
    private readonly Button _refresh = Btn("Refresh Dispatch");
    private readonly Button _cancel = Btn("Cancel Selected");
    private readonly Button _reassign = Btn("Reassign Selected");
    private readonly Label _message = StatusLabel("");

    private readonly DataGridView _approvalGrid = Grid();
    private readonly Button _approvalRefresh = Btn("Refresh Job Log");
    private readonly Button _approve = Btn("Approve Selected");
    private readonly Button _decline = Btn("Decline Selected");
    private readonly Label _approvalStatus = StatusLabel("Tracked deliveries and staff review history.");

    private readonly DataGridView _payoutGrid = Grid();
    private readonly Button _payoutRefresh = Btn("Refresh Payouts");
    private readonly Button _payoutRetry = Btn("Retry Selected");
    private readonly Label _payoutStatus = StatusLabel("ETS2/ATS payout history created after job approval.");

    public DispatchShell()
    {
        Text = "Sterling Dispatch — Staff Edition 1.0.4";
        Size = new Size(1360, 900);
        MinimumSize = new Size(1100, 760);
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7,15,27);
        ForeColor = Color.White;
        Font = new Font("Segoe UI", 10f);

        var tabs = new TabControl { Dock = DockStyle.Fill };
        var trackerTab = new TabPage("Driver Tracker") { BackColor = BackColor };
        var dispatchTab = new TabPage("Dispatch / Staff") { BackColor = BackColor, Padding = new Padding(12) };
        var approvalsTab = new TabPage("Job Log / Approvals") { BackColor = BackColor, Padding = new Padding(12) };
        var payoutsTab = new TabPage("Payout Monitor") { BackColor = BackColor, Padding = new Padding(12) };
        tabs.TabPages.AddRange([trackerTab,dispatchTab,approvalsTab,payoutsTab]);
        Controls.Add(tabs);

        _tracker.TopLevel = false;
        _tracker.FormBorderStyle = FormBorderStyle.None;
        _tracker.Dock = DockStyle.Fill;
        trackerTab.Controls.Add(_tracker);
        _tracker.Show();

        BuildDispatch(dispatchTab);
        BuildApprovals(approvalsTab);
        BuildPayouts(payoutsTab);

        _refresh.Click += async (_,_) => await RefreshDispatchAsync();
        _create.Click += async (_,_) => await CreateAsync();
        _cancel.Click += async (_,_) => await CancelAsync();
        _reassign.Click += async (_,_) => await ReassignAsync();
        _approvalRefresh.Click += async (_,_) => await RefreshApprovalsAsync();
        _approve.Click += async (_,_) => await DecideAsync("approve");
        _decline.Click += async (_,_) => await DecideAsync("decline");
        _payoutRefresh.Click += async (_,_) => await RefreshPayoutsAsync();
        _payoutRetry.Click += async (_,_) => await RetryPayoutAsync();
        _assignmentFilter.SelectedIndexChanged += async (_,_) => await RefreshDispatchAsync();
        _approvalFilter.SelectedIndexChanged += async (_,_) => await RefreshApprovalsAsync();
        _payoutFilter.SelectedIndexChanged += async (_,_) => await RefreshPayoutsAsync();
        tabs.SelectedIndexChanged += async (_,_) =>
        {
            if(tabs.SelectedTab==dispatchTab)await RefreshDispatchAsync();
            else if(tabs.SelectedTab==approvalsTab)await RefreshApprovalsAsync();
            else if(tabs.SelectedTab==payoutsTab)await RefreshPayoutsAsync();
        };
        FormClosing += (_,_) => { try { _tracker.Close(); } catch { } _api.Dispose(); };
    }

    private void BuildDispatch(Control host)
    {
        var root = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 4 };
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 48));root.RowStyles.Add(new RowStyle(SizeType.Absolute, 255));root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));root.RowStyles.Add(new RowStyle(SizeType.Absolute, 50));host.Controls.Add(root);
        var top = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4 };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,70));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,150));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));
        top.Controls.Add(_staffStatus,0,0);top.Controls.Add(Label("Show"),1,0);top.Controls.Add(_assignmentFilter,2,0);top.Controls.Add(_refresh,3,0);root.Controls.Add(top,0,0);
        var createCard = new GroupBox { Text = "CREATE DRIVER ASSIGNMENT — SELECT OR TYPE CARGO AND ROUTE", Dock = DockStyle.Fill, ForeColor = Color.White, Padding = new Padding(10) };
        var form = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 4, RowCount = 4 };form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,115));form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));form.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,115));form.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));
        Add(form,0,"Driver",_driver);Add(form,1,"Cargo",_cargo);Add(form,2,"From",_origin);Add(form,3,"To",_destination);form.Controls.Add(Label("Min miles"),0,2);form.Controls.Add(_minMiles,1,2);form.Controls.Add(Label("Deadline"),2,2);form.Controls.Add(_deadline,3,2);form.Controls.Add(Label("Notes"),0,3);form.Controls.Add(_notes,1,3);form.SetColumnSpan(_notes,2);form.Controls.Add(_create,3,3);createCard.Controls.Add(form);root.Controls.Add(createCard,0,1);
        _grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Job",DataPropertyName="WorkCode",Width=105 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Driver",DataPropertyName="Driver",Width=190 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Cargo",DataPropertyName="Cargo",Width=150 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="From",DataPropertyName="Origin",Width=120 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="To",DataPropertyName="Destination",Width=120 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Status",DataPropertyName="Status",Width=105 });_grid.Columns.Add(new DataGridViewCheckBoxColumn { HeaderText="Tracker",DataPropertyName="TrackerVerified",Width=70 });_grid.Columns.Add(new DataGridViewTextBoxColumn { HeaderText="Miles",DataPropertyName="ActualMiles",Width=75,DefaultCellStyle=new DataGridViewCellStyle{Format="N1"} });root.Controls.Add(_grid,0,2);
        var actions=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=4};actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,170));actions.Controls.Add(_message,0,0);actions.Controls.Add(_reassign,2,0);actions.Controls.Add(_cancel,3,0);root.Controls.Add(actions,0,3);
    }

    private void BuildApprovals(Control host)
    {
        var root=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=3};root.RowStyles.Add(new RowStyle(SizeType.Absolute,50));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));root.RowStyles.Add(new RowStyle(SizeType.Absolute,54));host.Controls.Add(root);
        var top=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=4};top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,70));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,140));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,190));top.Controls.Add(_approvalStatus,0,0);top.Controls.Add(Label("Show"),1,0);top.Controls.Add(_approvalFilter,2,0);top.Controls.Add(_approvalRefresh,3,0);root.Controls.Add(top,0,0);
        foreach(var c in new[]{Col("Approval","ApprovalCode",120),Col("Driver","Driver",210),Col("Cargo","Cargo",150),Col("Route","Route",220),Col("Miles","Miles",80,"N1"),Col("Revenue","Revenue",100,"C2"),Col("Driver Pay","DriverPayment",100,"C2"),Col("Damage %","Damage",85,"N1"),Col("Status","Status",95),Col("Created","CreatedAt",160)})_approvalGrid.Columns.Add(c);root.Controls.Add(_approvalGrid,0,1);
        var actions=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=3};actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));actions.Controls.Add(StatusLabel("Only pending deliveries can be approved or declined. Approved work releases official stats and payout."),0,0);actions.Controls.Add(_approve,1,0);actions.Controls.Add(_decline,2,0);root.Controls.Add(actions,0,2);
    }

    private void BuildPayouts(Control host)
    {
        var root=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=1,RowCount=3};root.RowStyles.Add(new RowStyle(SizeType.Absolute,50));root.RowStyles.Add(new RowStyle(SizeType.Percent,100));root.RowStyles.Add(new RowStyle(SizeType.Absolute,54));host.Controls.Add(root);
        var top=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=4};top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,70));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,140));top.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,190));top.Controls.Add(_payoutStatus,0,0);top.Controls.Add(Label("Show"),1,0);top.Controls.Add(_payoutFilter,2,0);top.Controls.Add(_payoutRefresh,3,0);root.Controls.Add(top,0,0);
        foreach(var c in new[]{Col("ID","Id",70),Col("Driver","Driver",230),Col("Amount","Amount",110,"C2"),Col("Status","Status",100),Col("Requested","RequestedAt",180),Col("Applied","AppliedAt",180),Col("Last Error","Error",360)})_payoutGrid.Columns.Add(c);root.Controls.Add(_payoutGrid,0,1);
        var actions=new TableLayoutPanel{Dock=DockStyle.Fill,ColumnCount=2};actions.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));actions.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,180));actions.Controls.Add(StatusLabel("Pending payouts are picked up automatically by the driver's Tracker. Retry is available only for pending payouts."),0,0);actions.Controls.Add(_payoutRetry,1,0);root.Controls.Add(actions,0,2);
    }

    private async Task RefreshDispatchAsync()
    {
        SetBusy(true);
        try
        {
            if(!await _api.IsStaffAsync())throw new UnauthorizedAccessException("This profile is not authorised for Sterling Dispatch.");
            var drivers=await _api.GetDriversAsync();
            var catalog=await _api.GetCatalogAsync();
            var current=_driver.SelectedItem as DispatchDriver;
            _driver.DataSource=drivers;
            if(current is not null)_driver.SelectedItem=drivers.FirstOrDefault(x=>x.Id==current.Id);
            Populate(_cargo,catalog.Cargo);
            Populate(_origin,catalog.Locations);
            Populate(_destination,catalog.Locations);
            var rows=await _api.GetAssignmentsAsync(AssignmentMode());
            _grid.DataSource=rows;
            _staffStatus.Text=$"Dispatch authorised • {drivers.Count} active drivers • {rows.Count} job{(rows.Count==1?"":"s")} shown";
            _message.Text=$"Updated {DateTime.Now:HH:mm:ss} • {catalog.Cargo.Count} cargo • {catalog.Locations.Count} locations";
        }
        catch(Exception ex){_staffStatus.Text=ex.Message;_message.Text="Dispatch unavailable";}
        finally{SetBusy(false);}
    }

    private async Task RefreshApprovalsAsync()
    {
        try
        {
            _approvalRefresh.Enabled=false;
            var rows=await _api.GetJobApprovalsAsync(ApprovalMode());
            _approvalGrid.DataSource=rows;
            var pending=rows.Count(x=>string.Equals(x.Status,"pending",StringComparison.OrdinalIgnoreCase));
            _approvalStatus.Text=$"{rows.Count} tracked deliver{(rows.Count==1?"y":"ies")} shown • {pending} pending review";
        }
        catch(Exception ex){_approvalStatus.Text="Job log unavailable • "+ex.Message;}
        finally{_approvalRefresh.Enabled=true;}
    }

    private async Task RefreshPayoutsAsync()
    {
        try
        {
            _payoutRefresh.Enabled=false;
            var rows=await _api.GetPayoutsAsync(PayoutMode());
            _payoutGrid.DataSource=rows;
            var pending=rows.Count(x=>string.Equals(x.Status,"pending",StringComparison.OrdinalIgnoreCase));
            var errors=rows.Count(x=>!string.IsNullOrWhiteSpace(x.Error));
            _payoutStatus.Text=$"{rows.Count} payout{(rows.Count==1?"":"s")} shown • {pending} pending{(errors>0?$" • {errors} with sync errors":"")}";
        }
        catch(Exception ex){_payoutStatus.Text="Payout monitor unavailable • "+ex.Message;}
        finally{_payoutRefresh.Enabled=true;}
    }

    private async Task CreateAsync()
    {
        if(_driver.SelectedItem is not DispatchDriver d){MessageBox.Show("Select a driver first.");return;}
        var cargo=_cargo.Text.Trim();var origin=_origin.Text.Trim();var destination=_destination.Text.Trim();
        if(string.IsNullOrWhiteSpace(cargo)||string.IsNullOrWhiteSpace(origin)||string.IsNullOrWhiteSpace(destination)){MessageBox.Show("Cargo, From and To are required.");return;}
        if(string.Equals(origin,destination,StringComparison.OrdinalIgnoreCase)){MessageBox.Show("From and To must be different locations.");return;}
        SetBusy(true);
        try
        {
            var code=await _api.CreateAssignmentAsync(d.Id,cargo,origin,destination,(double)_minMiles.Value,_deadline.Checked?_deadline.Value:null,_notes.Text.Trim());
            _message.Text=$"Created {code} for {d.SterlingDriverId} • {cargo} • {origin} → {destination}";
            _cargo.Text="";_origin.Text="";_destination.Text="";_notes.Clear();_minMiles.Value=0;_deadline.Checked=false;
            _assignmentFilter.SelectedIndex=1;
            await RefreshDispatchAsync();
        }
        catch(Exception ex){MessageBox.Show(ex.Message,"Sterling Dispatch",MessageBoxButtons.OK,MessageBoxIcon.Warning);}
        finally{SetBusy(false);}
    }

    private DispatchAssignment? Selected()=>_grid.CurrentRow?.DataBoundItem as DispatchAssignment;

    private async Task CancelAsync()
    {
        var w=Selected();if(w is null){MessageBox.Show("Select an assignment first.");return;}
        if(w.Status is not ("assigned" or "in_progress")){MessageBox.Show("Only assigned or in-progress jobs can be cancelled.");return;}
        if(MessageBox.Show($"Cancel {w.WorkCode}?","Sterling Dispatch",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
        try{await _api.CancelAsync(w.WorkCode,"Cancelled in Sterling Dispatch Staff Edition");await RefreshDispatchAsync();}catch(Exception ex){MessageBox.Show(ex.Message);}
    }

    private async Task ReassignAsync()
    {
        var w=Selected();if(w is null||_driver.SelectedItem is not DispatchDriver d){MessageBox.Show("Select an assignment and the new driver.");return;}
        if(w.Status is not ("assigned" or "in_progress")){MessageBox.Show("Completed or cancelled jobs cannot be reassigned.");return;}
        try{await _api.ReassignAsync(w.WorkCode,d.Id);_message.Text=$"{w.WorkCode} reassigned to {d.SterlingDriverId}";await RefreshDispatchAsync();}catch(Exception ex){MessageBox.Show(ex.Message);}
    }

    private async Task DecideAsync(string decision)
    {
        if(_approvalGrid.CurrentRow?.DataBoundItem is not DispatchJobApproval a){MessageBox.Show("Select a tracked delivery first.");return;}
        if(!string.Equals(a.Status,"pending",StringComparison.OrdinalIgnoreCase)){MessageBox.Show("Only pending tracked deliveries can be reviewed.");return;}
        var verb=decision=="approve"?"approve":"decline";if(MessageBox.Show($"{char.ToUpper(verb[0])+verb[1..]} {a.ApprovalCode} for {a.Driver}?","Sterling Job Approval",MessageBoxButtons.YesNo,MessageBoxIcon.Question)!=DialogResult.Yes)return;
        try{_approve.Enabled=_decline.Enabled=false;await _api.DecideJobAsync(a.ApprovalCode,decision);await RefreshApprovalsAsync();await RefreshPayoutsAsync();}catch(Exception ex){MessageBox.Show(ex.Message,"Sterling Job Approval",MessageBoxButtons.OK,MessageBoxIcon.Warning);}finally{_approve.Enabled=_decline.Enabled=true;}
    }

    private async Task RetryPayoutAsync()
    {
        if(_payoutGrid.CurrentRow?.DataBoundItem is not DispatchPayout p){MessageBox.Show("Select a payout first.");return;}
        if(!string.Equals(p.Status,"pending",StringComparison.OrdinalIgnoreCase)){MessageBox.Show("Only pending payouts can be retried.");return;}
        try{_payoutRetry.Enabled=false;await _api.RetryPayoutAsync(p.Id);await RefreshPayoutsAsync();MessageBox.Show($"Payout {p.Id} has been returned to the automatic Tracker sync queue.","Sterling Payout",MessageBoxButtons.OK,MessageBoxIcon.Information);}catch(Exception ex){MessageBox.Show(ex.Message,"Sterling Payout",MessageBoxButtons.OK,MessageBoxIcon.Warning);}finally{_payoutRetry.Enabled=true;}
    }

    private string AssignmentMode()=>_assignmentFilter.Text switch{"Active"=>"active","Assigned"=>"assigned","In Progress"=>"in_progress","Completed"=>"completed","Cancelled"=>"cancelled",_=>"all"};
    private string ApprovalMode()=>_approvalFilter.Text switch{"Pending"=>"pending","Approved"=>"approved","Declined"=>"declined",_=>"all"};
    private string PayoutMode()=>_payoutFilter.Text switch{"Pending"=>"pending","Applied"=>"applied",_=>"all"};
    private void SetBusy(bool busy){_create.Enabled=!busy;_refresh.Enabled=!busy;_cancel.Enabled=!busy;_reassign.Enabled=!busy;}
    private static ComboBox Filter(params string[] values){var c=new ComboBox{Dock=DockStyle.Fill,DropDownStyle=ComboBoxStyle.DropDownList};c.Items.AddRange(values);c.SelectedIndex=0;return c;}
    private static ComboBox Selector()=>new(){Dock=DockStyle.Fill,DropDownStyle=ComboBoxStyle.DropDown,AutoCompleteMode=AutoCompleteMode.SuggestAppend,AutoCompleteSource=AutoCompleteSource.ListItems,MaxDropDownItems=20,IntegralHeight=false,DropDownHeight=320};
    private static void Populate(ComboBox box,IEnumerable<string> values){var text=box.Text;box.BeginUpdate();try{box.Items.Clear();box.Items.AddRange(values.Cast<object>().ToArray());}finally{box.EndUpdate();}box.Text=text;}
    private static DataGridView Grid()=>new(){Dock=DockStyle.Fill,ReadOnly=true,AllowUserToAddRows=false,AllowUserToDeleteRows=false,SelectionMode=DataGridViewSelectionMode.FullRowSelect,MultiSelect=false,AutoGenerateColumns=false,BackgroundColor=Color.FromArgb(9,18,31),ForeColor=Color.White,RowHeadersVisible=false};
    private static DataGridViewTextBoxColumn Col(string header,string prop,int width,string? format=null)=>new(){HeaderText=header,DataPropertyName=prop,Width=width,DefaultCellStyle=new DataGridViewCellStyle{Format=format}};
    private static Label StatusLabel(string t)=>new(){Text=t,Dock=DockStyle.Fill,ForeColor=Color.Gainsboro,TextAlign=ContentAlignment.MiddleLeft};
    private static Label Label(string t)=>new(){Text=t,Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Color.Gainsboro};
    private static Button Btn(string t)=>new(){Text=t,Dock=DockStyle.Fill,FlatStyle=FlatStyle.Flat,BackColor=Color.FromArgb(31,92,151),ForeColor=Color.White,FlatAppearance={BorderSize=0},Margin=new Padding(4)};
    private static void Add(TableLayoutPanel f,int row,string name,Control c){var col=row%2*2;var r=row/2;f.Controls.Add(Label(name),col,r);f.Controls.Add(c,col+1,r);}
}
