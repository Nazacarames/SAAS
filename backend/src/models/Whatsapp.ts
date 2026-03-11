import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Default,
    ForeignKey,
    BelongsTo,
    HasMany,
    DataType
} from "sequelize-typescript";
import Company from "./Company";
import Ticket from "./Ticket";
import Contact from "./Contact";

@Table({ tableName: "whatsapps" })
class Whatsapp extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @Column(DataType.TEXT)
    session: string;

    @Column(DataType.TEXT)
    qrcode: string;

    @Default("DISCONNECTED")
    @Column
    status: string; // 'CONNECTED' | 'DISCONNECTED' | 'OPENING' | 'qrcode'

    @Column
    battery: string;

    @Default(false)
    @Column
    plugged: boolean;

    @Default(false)
    @Column
    isDefault: boolean;

    @Default("")
    @Column(DataType.TEXT)
    greetingMessage: string;

    @Default("")
    @Column(DataType.TEXT)
    farewellMessage: string;

    @ForeignKey(() => Company)
    @AllowNull(false)
    @Column
    companyId: number;

    @BelongsTo(() => Company)
    company: Company;

    @HasMany(() => Ticket)
    tickets: Ticket[];

    @HasMany(() => Contact)
    contacts: Contact[];

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;
}

export default Whatsapp;
